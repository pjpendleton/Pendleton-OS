export const voiceClientPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#111827">
  <title>Pendleton OS Voice</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #0b1120; color: #f8fafc; display: grid; place-items: center; padding: max(24px,env(safe-area-inset-top)) 20px max(24px,env(safe-area-inset-bottom)); }
    main { width: min(100%,520px); display: grid; gap: 18px; }
    h1 { margin: 0; font-size: clamp(2rem,8vw,3.5rem); letter-spacing: -.04em; }
    p { color: #cbd5e1; line-height: 1.5; margin: 0; }
    label { display: grid; gap: 8px; color: #cbd5e1; font-size: .9rem; }
    input { width: 100%; padding: 16px; border-radius: 14px; border: 1px solid #334155; background: #111827; color: white; font-size: 16px; }
    .status { min-height: 76px; padding: 18px; border: 1px solid #334155; border-radius: 18px; background: #111827; display: grid; align-content: center; }
    .status strong { font-size: 1.2rem; }
    .status span { color: #94a3b8; margin-top: 4px; }
    .controls { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    button { min-height: 72px; border: 0; border-radius: 18px; font-size: 1.1rem; font-weight: 700; color: white; background: #2563eb; touch-action: manipulation; }
    button.secondary { background: #334155; }
    button.danger { background: #b91c1c; }
    button:disabled { opacity: .4; }
    #start { grid-column: 1 / -1; }
    .driving { display: flex; align-items: center; gap: 10px; }
    .driving input { width: 24px; height: 24px; }
  </style>
</head>
<body>
  <main>
    <div><h1>Pendleton OS</h1><p>Conversational voice, with Pendleton policy and audit controls.</p></div>
    <label>API access token<input id="token" type="password" autocomplete="off" placeholder="Paste once per session"></label>
    <label class="driving"><input id="driving" type="checkbox" checked> Driving mode</label>
    <div class="status" aria-live="polite"><strong id="state">Ready</strong><span id="detail">Tap Start Conversation when parked.</span></div>
    <div class="controls">
      <button id="start">Start Conversation</button>
      <button id="interrupt" class="secondary" disabled>Interrupt</button>
      <button id="stop" class="danger" disabled>End</button>
    </div>
    <audio id="speaker" autoplay></audio>
  </main>
  <script>
    const token = document.querySelector('#token');
    const driving = document.querySelector('#driving');
    const state = document.querySelector('#state');
    const detail = document.querySelector('#detail');
    const start = document.querySelector('#start');
    const interrupt = document.querySelector('#interrupt');
    const stop = document.querySelector('#stop');
    const speaker = document.querySelector('#speaker');
    let pc, dc, stream, sessionId;
    const auth = () => ({ Authorization: 'Bearer ' + token.value.trim() });
    const show = (title, message) => { state.textContent = title; detail.textContent = message; };
    const api = async (path, options = {}) => {
      const response = await fetch(path, { ...options, headers: { ...auth(), ...(options.headers || {}) } });
      if (!response.ok) throw new Error((await response.text()) || ('HTTP ' + response.status));
      return response;
    };
    const reset = () => {
      if (dc) dc.close();
      if (pc) pc.close();
      if (stream) stream.getTracks().forEach(track => track.stop());
      dc = pc = stream = undefined;
      start.disabled = false; interrupt.disabled = true; stop.disabled = true;
    };
    start.addEventListener('click', async () => {
      if (token.value.trim().length < 32) { show('Token required','Paste the Pendleton OS API token.'); return; }
      start.disabled = true;
      try {
        show('Connecting','Requesting microphone access...');
        const created = await api('/v1/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'voice', drivingMode: driving.checked }) });
        sessionId = (await created.json()).sessionId;
        pc = new RTCPeerConnection();
        pc.ontrack = event => { speaker.srcObject = event.streams[0]; };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'connected') show('Listening','Speak naturally. You can interrupt at any time.');
          if (['failed','disconnected','closed'].includes(pc.connectionState)) show('Disconnected','End the session and reconnect.');
        };
        dc = pc.createDataChannel('oai-events');
        dc.onopen = () => { interrupt.disabled = false; stop.disabled = false; };
        dc.onmessage = async event => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'input_audio_buffer.speech_started') show('Listening','I hear you.');
            if (message.type === 'response.audio.delta') show('Speaking','Tap Interrupt or begin speaking.');
            if (message.type === 'response.done') show('Listening','Go ahead.');
            if (message.type === 'response.output_item.done' && message.item?.type === 'function_call' && message.item.name === 'propose_artifact_create') {
              show('Checking action','Applying Pendleton OS policy and verification controls...');
              let output;
              try {
                const args = JSON.parse(message.item.arguments || '{}');
                const result = await api('/v1/voice/artifacts', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    idempotencyKey: message.item.call_id,
                    title: args.title,
                    text: args.text,
                    drivingMode: driving.checked
                  })
                });
                output = { ok: true, result: await result.json() };
              } catch (error) {
                output = { ok: false, error: error instanceof Error ? error.message : 'Action failed' };
              }
              dc.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: message.item.call_id, output: JSON.stringify(output) } }));
              dc.send(JSON.stringify({ type: 'response.create' }));
            }
          } catch {}
        };
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => pc.addTrack(track, stream));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const answer = await api('/v1/conversations/' + sessionId + '/realtime', { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer.sdp });
        await pc.setRemoteDescription({ type: 'answer', sdp: await answer.text() });
      } catch (error) {
        show('Could not connect', error instanceof Error ? error.message : 'Unknown error');
        reset();
      }
    });
    interrupt.addEventListener('click', () => {
      if (dc?.readyState === 'open') dc.send(JSON.stringify({ type: 'response.cancel' }));
      show('Listening','Go ahead.');
    });
    stop.addEventListener('click', async () => {
      const closing = sessionId;
      reset();
      if (closing) { try { await api('/v1/conversations/' + closing + '/close', { method: 'POST' }); } catch {} }
      sessionId = undefined;
      show('Ended','The conversation is closed and its durable record is retained.');
    });
  </script>
</body>
</html>`;
