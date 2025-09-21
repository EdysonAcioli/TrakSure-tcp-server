// quick syntax check by requiring the module without executing run()
try {
  require("./consumer.js");
  console.log("require ok");
} catch (err) {
  console.error("require error:", err && err.message);
  process.exit(1);
}
