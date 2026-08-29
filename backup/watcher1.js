const path = require('path');
const chokidar = require('chokidar');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const open = require('open');
require('dotenv').config();
const { execFile } = require('child_process');
const sendReceiptEmail = require('./email');

const BACKEND_URL = 'https://whatsapp-receipts-backend.onrender.com';
let authToken = null;

async function loginAndGetToken() {
  const response = await fetch(BACKEND_URL + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.WATCHER_EMAIL,
      password: process.env.WATCHER_PASSWORD
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error('Login failed: ' + (data.error || 'unknown error'));
  }
  authToken = data.token;
  console.log('Logged in as ' + data.business_name + ' (business_id ' + data.id + ')\n');
}

async function saveInvoice(customerContact, deliveryMethod, receiptText) {
  try {
    const response = await fetch(BACKEND_URL + '/invoices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + authToken
      },
      body: JSON.stringify({
        customer_contact: customerContact,
        delivery_method: deliveryMethod,
        receipt_text: receiptText
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('Failed to save invoice:', data.error);
      return null;
    } else {
      console.log('Invoice saved to database, id:', data.id);
      return data.id;
    }
  } catch (err) {
    console.error('Error saving invoice:', err.message);
    return null;
  }
}

const WATCH_FOLDER = 'C:\\ReceiptCapture';
const CHOICE_FILE = 'C:\\ReceiptCapture\\choice.txt';
const POPUP_EXE = path.join(path.dirname(process.execPath), 'channel-popup.exe');
const AHK_EXE = 'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe';

loginAndGetToken()
  .then(() => {
    console.log(`Watching folder: ${WATCH_FOLDER}`);
    console.log('Print a test receipt now (as a new PDF file)...\n');
  })
  .catch(err => {
    console.error('Could not log in:', err.message);
    console.error('Fix your WATCHER_EMAIL/WATCHER_PASSWORD in .env and try again.');
    process.exit(1);
  });

const watcher = chokidar.watch(WATCH_FOLDER, {
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 1000,
    pollInterval: 200
  }
});

function waitForChoiceFile(timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (fs.existsSync(CHOICE_FILE)) {
        clearInterval(interval);
        const content = fs.readFileSync(CHOICE_FILE, 'utf8').trim();
        fs.unlinkSync(CHOICE_FILE);
        resolve(content);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error('Timed out waiting for cashier to make a choice.'));
      }
    }, 500);
  });
}

watcher.on('add', async function(filePath) {
  if (!filePath.toLowerCase().endsWith('.pdf')) return;

  console.log(`New file detected: ${filePath}`);

    try {
    let dataBuffer = fs.readFileSync(filePath);

    let retries = 0;
    while (dataBuffer.length === 0 && retries < 10) {
      console.log('File is still empty, waiting for it to finish writing...');
      await new Promise(r => setTimeout(r, 500));
      dataBuffer = fs.readFileSync(filePath);
      retries++;
    }

    if (dataBuffer.length === 0) {
      console.error('File never finished writing after 5 seconds, skipping:', filePath);
      return;
    }

        const result = await pdfParse(dataBuffer);

    const receiptText = result.text.trim();

    console.log('--- Extracted text ---');
    console.log(receiptText);
    console.log('----------------------\n');

    if (fs.existsSync(CHOICE_FILE)) {
      fs.unlinkSync(CHOICE_FILE);
    }

    console.log('Opening delivery choice popup...');
    execFile(POPUP_EXE);

    const choice = await waitForChoiceFile();
    const parts = choice.split(',');
    const method = parts[0];
    const contact = parts[1];

    console.log('Cashier chose: ' + method + (contact ? ' (' + contact + ')' : ''));

if (method === 'whatsapp') {
      const invoiceId = await saveInvoice(contact, 'whatsapp', receiptText);
      const receiptLink = 'https://whatsapp-receipts-backend.onrender.com/r/' + invoiceId;
      const message = 'Here is your receipt: ' + receiptLink + '\n\nThank you for your order!';
      const link = 'https://web.whatsapp.com/send?phone=' + contact + '&text=' + encodeURIComponent(message);
            console.log('Opening WhatsApp with the receipt link pre-filled...\n');
      await open(link);
        } else if (method === 'email') {

      console.log('Sending email to ' + contact + '...');
      try {
        const emailResult = await sendReceiptEmail(contact, receiptText);
                if (emailResult.error) {
          console.error('Email failed to send:', emailResult.error.message);
        } else {
          console.log('Email sent successfully.\n');
          await saveInvoice(contact, 'email', receiptText);
        }
      } catch (emailErr) {
        console.error('Error sending email:', emailErr.message);
      }
        } else if (method === 'print') {
      console.log('Print only chosen — nothing more to do.\n');
      await saveInvoice(null, 'print', receiptText);
    } else {
      console.log('Unrecognized choice — skipping.\n');
    }

  } catch (err) {
    console.error('Error processing PDF:', err.message);
  }
});