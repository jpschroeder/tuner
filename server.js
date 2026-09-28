// server.js
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8000;

http
  .createServer((req, res) => {
    let filePath = req.url === "/" ? "/index.html" : req.url;
    filePath = path.join(__dirname, filePath);

    const ext = path.extname(filePath);
    const mimeTypes = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".glsl": "text/plain",
      ".wav": "audio/wav",
    };

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("File not found");
        return;
      }

      // Headers required to enable SharedArrayBuffer in modern browsers
      res.writeHead(200, {
        "Content-Type": mimeTypes[ext] || "application/octet-stream",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      });
      res.end(data);
    });
  })
  .listen(PORT, () => {
    console.log(`Secure Strobe Tuner running at http://localhost:${PORT}`);
  });
