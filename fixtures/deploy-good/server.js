const http = require("http");
const fs = require("fs");

const port = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("healthy-good-release");
  }
  if (req.url === "/env") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end(process.env.DEPLOY_FIXTURE_VALUE || "missing");
  }
  if (req.url === "/volume") {
    let value = "missing";
    try { value = fs.readFileSync("/app/data/proof.txt", "utf8").trim(); } catch {}
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end(value);
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("my-railway-good-release");
});
server.listen(port, "0.0.0.0");
