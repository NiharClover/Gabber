require("dotenv").config();
const { io } = require("socket.io-client");
const axios = require("axios");

const BASE_URL = "http://localhost:3000";

const OTP1 = "843940"; // <-- paste from server console
const OTP2 = "542520"; // <-- paste from server console

async function main() {
  const res1 = await axios.post(`${BASE_URL}/api/auth/verify-otp`, {
    phone: "+919137800893", otp: OTP1, username: "Arjun",
  });
  const res2 = await axios.post(`${BASE_URL}/api/auth/verify-otp`, {
    phone: "+912222222222", otp: OTP2, username: "Priya",
  });

  const user1 = res1.data;
  const user2 = res2.data;
  console.log("[user1]", user1.user);
  console.log("[user2]", user2.user);

  const socket1 = io(BASE_URL, { auth: { token: user1.token } });
  const socket2 = io(BASE_URL, { auth: { token: user2.token } });

  socket2.on("message:receive", (msg) => {
    console.log(`\n[user2 received] "${msg.text}" from ${msg.fromName}`);
    console.log("  chatId:", msg.chatId);
    console.log("  messageId:", msg.id);
  });

  socket1.on("message:sent", (msg) => {
    console.log(`\n[user1 sent] "${msg.text}" → status: ${msg.status}`);
  });

  socket1.on("connect", () => {
    console.log("[socket1] connected");
    setTimeout(() => {
      socket1.emit("message:send", {
        to: user2.user.userId,
        text: "Hey Priya! Gabber is working 🎉",
      });
    }, 1000);
  });

  socket2.on("connect", () => console.log("[socket2] connected"));

  setTimeout(() => {
    socket1.disconnect();
    socket2.disconnect();
    process.exit(0);
  }, 5000);
}

main().catch(console.error);