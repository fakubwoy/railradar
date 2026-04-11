const fs = require('fs');

const rapidapiKey = process.env.RAPIDAPI_KEY || '';
const geminiKey = process.env.GEMINI_API_KEY || '';

const configContent = `window.RAILRADAR_CONFIG = {
  RAPIDAPI_KEY: "${rapidapiKey}",
  GEMINI_API_KEY: "${geminiKey}"
};
`;

fs.writeFileSync('config.js', configContent);
console.log('✅ config.js generated');