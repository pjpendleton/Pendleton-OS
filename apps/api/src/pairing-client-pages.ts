export const pairingAdminPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#111827">
  <title>Pair a Device | Pendleton OS</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #0b1120; color: #f8fafc; display: grid; place-items: center; padding: 24px 20px; }
    main { width: min(100%,560px); display: grid; gap: 18px; }
    h1 { margin: 0; font-size: clamp(2rem,7vw,3.2rem); letter-spacing: -.04em; }
    p { color: #cbd5e1; line-height: 1.5; margin: 0; }
    label { display: grid; gap: 8px; color: #cbd5e1; }
    input { width: 100%; padding: 16px; border-radius: 14px; border: 1px solid #334155; background: #111827; color: white; font-size: 16px; }
    button { min-height: 64px; border: 0; border-radius: 18px; font-size: 1.05rem; font-weight: 700; color: white; background: #2563eb; }
    button:disabled { opacity: .45; }
    .card { padding: 20px; border: 1px solid #334155; border-radius: 20px; background: #111827; display: grid; gap: 14px; }
    #result { display: none; text-align: center; }
    #result img { width: min(100%,320px); margin: auto; padding: 12px; border-radius: 18px; background: white; }
    #status { min-height: 24px; color: #93c5fd; }
    a { color: #93c5fd; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <div><h1>Pair your iPhone</h1><p>Authorize once on this desktop. The QR code expires in five minutes and can be used only once.</p></div>
    <section class="card" id="authorize">
      <label>Administrator access token<input id="token" type="password" autocomplete="off" placeholder="Pendleton OS API token"></label>
      <button id="create">Create secure pairing code</button>
      <p id="status" aria-live="polite"></p>
    </section>
    <section class="card" id="result">
      <strong>Scan with your iPhone camera</strong>
      <img id="qr" alt="One-time Pendleton OS device pairing QR code">
      <p id="expires"></p>
      <a id="claim" href="#">Open pairing link</a>
    </section>
  </main>
  <script>
    const token = document.querySelector('#token');
    const create = document.querySelector('#create');
    const status = document.querySelector('#status');
    const result = document.querySelector('#result');
    const qr = document.querySelector('#qr');
    const expires = document.querySelector('#expires');
    const claim = document.querySelector('#claim');
    create.addEventListener('click', async () => {
      if (token.value.trim().length < 32) { status.textContent = 'Enter the administrator token.'; return; }
      create.disabled = true;
      status.textContent = 'Creating a one-time code...';
      try {
        const response = await fetch('/v1/device-pairings', { method: 'POST', headers: { Authorization: 'Bearer ' + token.value.trim() } });
        if (!response.ok) throw new Error(response.status === 401 ? 'Administrator token not accepted.' : 'Pairing could not be created.');
        const pairing = await response.json();
        token.value = '';
        qr.src = pairing.qrCodeDataUrl;
        claim.href = pairing.claimUrl;
        expires.textContent = 'Expires at ' + new Date(pairing.expiresAt).toLocaleTimeString();
        result.style.display = 'grid';
        status.textContent = 'Ready to scan.';
      } catch (error) {
        status.textContent = error.message;
        create.disabled = false;
      }
    });
  </script>
</body>
</html>`;

export const pairingClaimPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#111827">
  <title>Pairing | Pendleton OS</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    body { margin: 0; min-height: 100vh; background: #0b1120; color: #f8fafc; display: grid; place-items: center; padding: 24px; text-align: center; }
    main { width: min(100%,480px); display: grid; gap: 14px; }
    h1 { margin: 0; font-size: 2.5rem; }
    p { color: #cbd5e1; line-height: 1.5; }
    a { display: none; padding: 18px; border-radius: 16px; color: white; background: #2563eb; text-decoration: none; font-weight: 700; }
  </style>
</head>
<body>
  <main><h1 id="title">Pairing device</h1><p id="detail">Securing this iPhone for Pendleton OS...</p><a id="continue" href="/voice">Open Pendleton OS Voice</a></main>
  <script>
    const title = document.querySelector('#title');
    const detail = document.querySelector('#detail');
    const link = document.querySelector('#continue');
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    history.replaceState(null, '', '/pair/claim');
    const fail = message => { title.textContent = 'Pairing failed'; detail.textContent = message; link.style.display = 'block'; link.textContent = 'Return to pairing'; link.href = '/pair'; };
    if (!token) fail('This pairing link is incomplete. Create a new code on the desktop.');
    else fetch('/v1/device-pairings/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
      .then(async response => { if (!response.ok) throw new Error((await response.json()).errors?.[0]?.code || 'PAIRING_FAILED'); return response.json(); })
      .then(() => { title.textContent = 'Device paired'; detail.textContent = 'This iPhone is ready for conversational voice.'; link.style.display = 'block'; setTimeout(() => location.replace('/voice'), 900); })
      .catch(error => fail(error.message === 'DEVICE_PAIRING_EXPIRED' ? 'The code expired. Create a new one on the desktop.' : 'The code is invalid or has already been used.'));
  </script>
</body>
</html>`;
