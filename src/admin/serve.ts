import app from "./app.js";

const port = Number(process.env.ADMIN_PORT) || 4100;
app.listen(port, () => {
  console.log(`cantkeepupwithai-pipeline admin API listening on :${port}`);
});
