// parse-worker.js
//
// Runs on your own laptop (where Ollama + Qwen are installed).
// Connects DIRECTLY to the Supabase Postgres database — same style as your
// existing Node.js backend (DB_HOST / DB_USER / DB_PASSWORD / etc), not the
// Supabase JS client. This keeps everything consistent with how your app
// already talks to the database.
//
// This script is completely separate from the customer delivery flow
// (watcher.js / FloatingSendButton.exe / channel-popup.exe). It only reads
// invoices AFTER a receipt has already been sent — nothing here can slow
// down or block sending a receipt to a customer.
//
// SETUP:
// 1. Create a .env file next to this script with the SAME DB_HOST, DB_PORT,
//    DB_NAME, DB_USER, DB_PASSWORD your Render backend uses (copy them from
//    Render's Environment tab — same values, this just runs from your laptop
//    instead of Render).
// 2. Add: OLLAMA_URL=http://localhost:11434  and  QWEN_MODEL=qwen3:8b
//    (only needed if different from the defaults below)
// 3. npm install pg dotenv
// 4. Run with: node parse-worker.js
//    (Consider running it with pm2 so it restarts automatically if your
//    laptop reboots.)

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL_NAME = process.env.QWEN_MODEL || 'qwen3:8b';
const POLL_INTERVAL_MS = 15000; // check for new work every 15 seconds
const BATCH_SIZE = 5; // small batches, so one slow document doesn't hold up a big backlog

// ---- Prompt: extraction ONLY, not customer identity (receipts don't print that) ----
function buildPrompt(receiptText) {
  return `You are extracting structured sales data from a business document (a receipt, invoice, quotation, purchase order, RFQ, or similar). This is NOT about who the customer is — only about what was sold.

Read the document text below and respond with ONLY a JSON object (no other text, no markdown formatting) in this exact shape:

{
  "document_type": "receipt" | "invoice" | "quotation" | "po" | "rfq" | "other",
  "invoice_number": string or null,
  "invoice_date": "YYYY-MM-DD" or null,
  "items": [ { "item_name": string, "quantity": number or null, "unit_price": number or null, "line_total": number or null } ],
  "subtotal": number or null,
  "vat_rate": number or null,
  "vat_amount": number or null,
  "total": number or null,
  "currency": string or null
}

If a field doesn't apply or isn't present, use null. If there's no VAT mentioned, set vat_amount and vat_rate to null (not 0) — don't assume VAT applies just because some businesses charge it.

Document text:
"""
${receiptText}
"""`;
}

async function parseWithQwen(receiptText) {
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_NAME,
      prompt: buildPrompt(receiptText),
      stream: false,
      format: 'json',
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  try {
    return JSON.parse(data.response);
  } catch (err) {
    throw new Error(`Qwen returned non-JSON output: ${String(data.response).slice(0, 200)}`);
  }
}

// ---- Figure out if customer_contact looks like a phone number or an email ----
function contactType(contact) {
  if (!contact) return null;
  return contact.includes('@') ? 'email' : 'phone';
}

// ---- Find or create the unified customer record for this contact ----
async function findOrCreateCustomer(client, contact) {
  const type = contactType(contact);
  if (!type) return null;

  const column = type === 'email' ? 'email' : 'phone';

  const { rows: existing } = await client.query(
    `select id from customers where ${column} = $1 limit 1`,
    [contact]
  );

  if (existing.length > 0) {
    return existing[0].id;
  }

  const { rows: created } = await client.query(
    `insert into customers (${column}) values ($1) returning id`,
    [contact]
  );
  return created[0].id;
}

// ---- Process one invoice ----
async function processInvoice(invoice) {
  const client = await pool.connect();
  try {
    await client.query(
      `update invoices set parse_status = 'processing' where id = $1`,
      [invoice.id]
    );

    if (!invoice.receipt_text || invoice.receipt_text.trim() === '') {
      throw new Error('No receipt_text to parse');
    }

    const result = await parseWithQwen(invoice.receipt_text);
    const customerId = await findOrCreateCustomer(client, invoice.customer_contact);

    await client.query('begin');

    await client.query(
      `update invoices set
        customer_id = $1,
        document_type = $2,
        invoice_number = $3,
        invoice_date = $4,
        subtotal = $5,
        vat_rate = $6,
        vat_amount = $7,
        total = $8,
        currency = $9,
        parse_status = 'completed',
        parsed_at = now(),
        parse_error = null
      where id = $10`,
      [
        customerId,
        result.document_type ?? null,
        result.invoice_number ?? null,
        result.invoice_date ?? null,
        result.subtotal ?? null,
        result.vat_rate ?? null,
        result.vat_amount ?? null,
        result.total ?? null,
        result.currency ?? null,
        invoice.id,
      ]
    );

    // Clear out any previously-inserted items (in case this invoice is being re-parsed)
    await client.query(`delete from invoice_items where invoice_id = $1`, [invoice.id]);

    for (const item of result.items || []) {
      await client.query(
        `insert into invoice_items (invoice_id, item_name, quantity, unit_price, line_total)
         values ($1, $2, $3, $4, $5)`,
        [invoice.id, item.item_name ?? null, item.quantity ?? null, item.unit_price ?? null, item.line_total ?? null]
      );
    }

    await client.query('commit');
    console.log(`Parsed invoice ${invoice.id} -> ${result.document_type}, ${result.items?.length ?? 0} items`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    console.error(`Failed to parse invoice ${invoice.id}:`, err.message);
    await client.query(
      `update invoices set parse_status = 'failed', parse_error = $1 where id = $2`,
      [err.message, invoice.id]
    );
  } finally {
    client.release();
  }
}

async function pollOnce() {
  const { rows: pending } = await pool.query(
    `select id, receipt_text, customer_contact
     from invoices
     where parse_status = 'pending'
     order by created_at asc
     limit $1`,
    [BATCH_SIZE]
  );

  for (const invoice of pending) {
    await processInvoice(invoice);
  }
}

async function main() {
  console.log(`Parse worker started. Polling every ${POLL_INTERVAL_MS / 1000}s.`);
  while (true) {
    try {
      await pollOnce();
    } catch (err) {
      console.error('Poll error:', err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();
