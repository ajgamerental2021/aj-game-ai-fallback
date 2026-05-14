const pingUrl = process.env.PING_URL;

if (!pingUrl) {
  console.error("Missing PING_URL environment variable");
  process.exit(1);
}

try {
  const response = await fetch(pingUrl, {
    headers: {
      "User-Agent": "aj-game-render-cron-ping/1.0",
    },
  });

  const body = await response.text();
  console.log(`Pinged ${pingUrl}: ${response.status}`);
  console.log(body.slice(0, 500));

  if (!response.ok) {
    process.exit(1);
  }
} catch (error) {
  console.error("Ping failed:", error);
  process.exit(1);
}
