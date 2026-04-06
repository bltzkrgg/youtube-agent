'use strict';

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const envExample = path.join(rootDir, '.env.example');
const envFile = path.join(rootDir, '.env');

function main() {
  if (!fs.existsSync(envExample)) {
    console.error('File .env.example tidak ditemukan.');
    process.exit(1);
  }

  if (!fs.existsSync(envFile)) {
    fs.copyFileSync(envExample, envFile);
    console.log('File .env dibuat dari .env.example');
  } else {
    console.log('File .env sudah ada, tidak diubah.');
  }

  console.log('');
  console.log('Langkah berikutnya:');
  console.log('1. Isi kredensial di file .env');
  console.log('2. Jalankan `npm install`');
  console.log('3. Jalankan `python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt`');
  console.log('4. Start agent dengan `node src/index.js --run-now` atau `npm start`');
}

main();
