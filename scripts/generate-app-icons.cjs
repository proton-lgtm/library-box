const { app, nativeImage } = require("electron");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

app.whenReady().then(() => {
  const assets = path.resolve(__dirname, "../assets");
  const logo = nativeImage.createFromBuffer(readFileSync(path.join(assets, "logo.png")));
  const { width, height } = logo.getSize();
  if (logo.isEmpty() || width !== height || width < 1024) {
    throw new Error("assets/logo.png must be a square image at least 1024 pixels wide.");
  }
  const output = path.join(assets, "icons");
  mkdirSync(output, { recursive: true });
  const png = (size) => logo.resize({ width: size, height: size, quality: "best" }).toPNG();
  writeFileSync(path.join(output, "icon.png"), png(512));

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map(png);
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  });
  writeFileSync(path.join(output, "icon.ico"), Buffer.concat([header, ...images]));

  const chunks = [
    ["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128],
    ["ic08", 256], ["ic09", 512], ["ic10", 1024],
  ].map(([type, size]) => {
    const image = png(size);
    const chunk = Buffer.alloc(8);
    chunk.write(type, 0, "ascii");
    chunk.writeUInt32BE(8 + image.length, 4);
    return Buffer.concat([chunk, image]);
  });
  const icnsHeader = Buffer.alloc(8);
  icnsHeader.write("icns", 0, "ascii");
  icnsHeader.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  writeFileSync(path.join(output, "icon.icns"), Buffer.concat([icnsHeader, ...chunks]));
  console.log("Generated Windows, macOS, and Linux app icons from assets/logo.png.");
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
