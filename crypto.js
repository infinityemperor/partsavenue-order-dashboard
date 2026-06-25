// ============================================================
// Дешифрование токена. Та же схема что в encrypt.html, обратно.
// AES-256-GCM, ключ из пароля через PBKDF2-SHA-256 (100k итераций).
// salt(16) + iv(12) + ciphertext → base64.
// ============================================================

async function decryptToken(blobBase64, password) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // base64 → bytes
  const raw = Uint8Array.from(atob(blobBase64), c => c.charCodeAt(0));
  const salt = raw.slice(0, 16);
  const iv = raw.slice(16, 28);
  const ciphertext = raw.slice(28);

  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password),
    { name: "PBKDF2" }, false, ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false, ["decrypt"]
  );

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv }, key, ciphertext
    );
    return dec.decode(plaintext);
  } catch (e) {
    // AES-GCM проверяет MAC; неверный пароль → исключение OperationError.
    // Возвращаем null чтобы вызывающий код мог отличить «неверный пароль»
    // от технического сбоя.
    return null;
  }
}
