module.exports = async function globalTeardown() {
  try {
    await fetch("http://127.0.0.1:4173/__test_shutdown");
  } catch {}
};
