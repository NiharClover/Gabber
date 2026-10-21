const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Module = require("module");

const roots = ["src", "test"];
const files = [];

function collectJavaScriptFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectJavaScriptFiles(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
}

for (const root of roots) collectJavaScriptFiles(path.resolve(root));

for (const file of files) {
  try {
    const source = fs.readFileSync(file, "utf8");
    new vm.Script(Module.wrap(source), { filename: file });
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

console.log(`Syntax check passed for ${files.length} JavaScript files.`);
