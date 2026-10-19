/**
 * VideoGrab — Offscreen Factory
 * Responsável por hospedar o Web Worker de download (LibAV/FFmpeg WASM)
 * e o iframe de sandbox para avaliação isolada de scripts de decifragem.
 */

const CHANNELS = {
  FromServiceToWorker: 2,
  FromWorkerToService: 3
};

const workerUrl = chrome.runtime.getURL("/download_worker/main.js");
const downloadWorker = new Worker(workerUrl, { type: "module" });

downloadWorker.addEventListener("error", (err) => {
  console.error("[VideoGrab Factory] Erro no download_worker:", err);
});

const bus = new BroadcastChannel("worker_service");
const sandboxFrame = document.getElementById("eval-sandbox");

// Recebe respostas do iframe sandbox e repassa ao Service Worker
window.addEventListener("message", (event) => {
  const { type, uid, success, error } = event.data || {};
  if (type === "EVAL_RESULT" && uid) {
    bus.postMessage({
      channel: CHANNELS.FromWorkerToService,
      msg: {
        name: "eval_qjs_result",
        data: { uid, success, error }
      }
    });
  }
});

// Escuta solicitações de avaliação vindas do Service Worker
bus.addEventListener("message", (event) => {
  const { channel, msg } = event.data || {};
  if (channel !== CHANNELS.FromServiceToWorker || !msg) return;

  if (msg.name === "eval_qjs" && sandboxFrame?.contentWindow) {
    sandboxFrame.contentWindow.postMessage(
      {
        type: "EVAL_CODE",
        uid: msg.data.uid,
        code: msg.data.code
      },
      "*"
    );
  }
});
