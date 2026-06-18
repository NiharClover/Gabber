require("dotenv").config();
const axios = require("axios");

const BASE_URL = "http://localhost:3000";

async function main() {
  await axios.post(`${BASE_URL}/api/auth/send-otp`, { phone: "+911111111111" });
  await axios.post(`${BASE_URL}/api/auth/send-otp`, { phone: "+912222222222" });
  console.log("Done! Check server console for both OTPs.");
}

main().catch(console.error);