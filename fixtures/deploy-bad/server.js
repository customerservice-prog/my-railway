const http = require("http");

const port = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(503, { "content-type": "text/plain" });
    return res.end("intentionally-unhealthy-release");
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("bad-release-should-never-take-traffic");
});
server.listen(port, "0.0.0.0");
