# AGENTS.md — Guia de Instruções para Agentes de IA

Este documento orienta agentes de IA e desenvolvedores sobre a arquitetura, convenções, protocolos e fluxos de trabalho do projeto **VideoGrab**.

---

## 1. Visão Geral do Projeto

**VideoGrab** é uma extensão de navegador construída sob o padrão **Manifest V3 (MV3)** para Chromium (Chrome, Edge, Brave, etc.). Sua finalidade é detectar, interceptar e baixar fluxos de mídia da web (HTTP direto, HLS `.m3u8`, MPEG-DASH `.mpd`, YouTube, Vimeo e redes sociais) com remuxing e conversão local em **WebAssembly (FFmpeg / LibAV)** via **OPFS (Origin Private File System)**, sem dependência de ferramentas externas no sistema operacional, sem timers de cooldown e sem paywalls.

---

## 2. Estrutura do Repositório

```text
video_grab/
├── manifest.json                 # Manifesto da extensão (MV3: permissions, background, CSP, sandbox)
├── README.md                     # Documentação pública e instruções de instalação
├── AGENTS.md                     # Este guia de orientação para agentes
├── icons/                        # Ícones PNG estáticos (16x16, 48x48, 128x128 e 128-grey)
├── service/                      # Background Service Worker (ES Modules)
│   ├── main.js                   # Ponto de entrada do Service Worker, estado em memória e roteador de mensagens
│   ├── serde.js                  # Serializador/Deserializador compatível com o worker (__serde_tag) e tipos Option/Result
│   ├── sniffer.js                # Interceptador webRequest para HTTP, HLS (.m3u8) e DASH (.mpd)
│   ├── dnr_headers.js            # Injeção dinâmica de cabeçalhos via declarativeNetRequest
│   └── downloader.js             # Orquestrador de tarefas de download, ponte com o Worker e salvamento
├── factory/                      # Documento Offscreen (chrome.offscreen)
│   ├── factory.html              # Documento hospedeiro do Web Worker e do Sandbox
│   ├── factory.js                # Inicializador do download_worker e ponte BroadcastChannel
│   └── sandbox.html              # Iframe isolado (CSP permissivo) para avaliação de ciphers dinâmicos
├── download_worker/              # Motor de processamento de mídia em WebAssembly
│   ├── main.js                   # Web Worker com as 16 estratégias de muxing/download
│   ├── libav-6.5.7.1-h264-aac-mp3.wasm.mjs # Wrapper JS do FFmpeg/LibAV
│   └── libav-6.5.7.1-h264-aac-mp3.wasm.wasm# Binário WebAssembly do FFmpeg/LibAV
├── injected/                     # Content Scripts injetados nas abas
│   ├── media_detector.js         # Detector universal no DOM (<video>, <audio>, metadados OpenGraph)
│   └── *.js                      # Extratores específicos por plataforma (youtube.js, vimeo.js, etc.)
└── ui/                           # Interface do Usuário (HTML/CSS/JS nativos)
    ├── popup.html                # Popup da ação da barra de ferramentas
    ├── sidebar.html              # Painel lateral do navegador (chrome.sidePanel)
    ├── styles.css                # Design system com variáveis CSS e suporte dark/light mode
    └── app.js                    # Controlador de eventos e renderização da UI
```

---

## 3. Arquitetura e Invariantes Críticos

Ao modificar ou estender o código, **respeite sempre as seguintes regras arquiteturais**:

### A. Conformidade com Manifest V3
1. **Sem `eval()` no Service Worker ou Páginas da Extensão**:
   - A CSP de páginas de extensão bloqueia estritamente `eval()` e `new Function()`.
   - Se for necessário avaliar scripts dinâmicos (como a decifragem de assinatura do player do YouTube), utilize a ponte do **Sandbox Iframe** em [`factory/sandbox.html`](./factory/sandbox.html), que está declarado em `"sandbox": { "pages": ["factory/sandbox.html"] }` no `manifest.json`.
2. **Ícones Válidos**:
   - O `manifest.json` **só** deve referenciar arquivos PNG existentes fisicamente em [`icons/`](./icons) com dimensões exatas correspondentes (`16x16`, `48x48`, `128x128`).
3. **Abertura do Side Panel**:
   - O método `chrome.sidePanel.open({ windowId })` exige um gesto direto do usuário (ex: clique no botão do popup).
4. **Sem Código Inline**:
   - Todo código JavaScript em arquivos `.html` deve ser importado via tag `<script type="module" src="...">`. Nunca use scripts ou atributos de evento inline (`onclick="..."`).

### B. Protocolo de Mensageria e Serde
O Worker de processamento [`download_worker/main.js`](./download_worker/main.js) comunica-se com o Service Worker exclusivamente através da `BroadcastChannel("worker_service")`:

- **Canais Numéricos**:
  - `FromInjectedToService = 0`: Injected scripts -> Service Worker (`on_media`, `qjs`, `do_fetch_from_service`).
  - `FromContentToService = 1`: Content scripts gerais -> Service Worker.
  - `FromServiceToWorker = 2`: Service Worker -> Download Worker (`download`, `abort_download`, `revoke_blob_url`, `is_ready`).
  - `FromWorkerToService = 3`: Download Worker -> Service Worker (`download_progress`, `download_result`, `download_error`, `is_ready_success`).
  - `FromServiceToInjected = 7`: Service Worker -> Injected scripts (`qjs_result`, `on_fetch_from_service`).
- **Serialização de Tipos Complexos (`serde.js`)**:
  - Objetos como `URL`, `Headers`, `Set`, `Map`, `Option` (`Some`/`None`) e `Result` (`Ok`/`Err`) enviados ao worker devem ser serializados através da função `serialize(obj)` e deserializados com `deserialize(raw)`.

### C. Armazenamento Temporário (OPFS)
- O motor de download grava os dados diretamente no **Origin Private File System (OPFS)** via `navigator.storage.getDirectory()` usando `createSyncAccessHandle()`.
- Após a conclusão do download pelo navegador (`chrome.downloads.download`), o Service Worker em [`service/downloader.js`](./service/downloader.js) é responsável por remover o arquivo temporário do OPFS e revogar o Blob URL para liberar memória.

### D. Regras DeclarativeNetRequest (DNR)
- Streams que exigem cabeçalhos específicos da página (`Referer`, `Origin`, `Cookie`) têm regras de cabeçalho injetadas temporariamente na sessão via `chrome.declarativeNetRequest.updateSessionRules`.
- Sempre garanta que as regras criadas sejam removidas no bloco `finally` da execução do download.

---

## 4. Como Adicionar ou Modificar Recursos

### Adicionando um Novo Extrator de Site Específico
1. Crie o content script em [`injected/meu_site.js`](./injected).
2. Se o site exigir acesso a variáveis globais da página (ex: `window.playerConfig`), crie também `injected/meu_site_untrusted.js` rodando em `world: "MAIN"`, comunicando-se com o script seguro via `BroadcastChannel`.
3. Registre o script no array `"content_scripts"` de [`manifest.json`](./manifest.json).
4. Envie as mídias detectadas para o Service Worker com:
   ```javascript
   chrome.runtime.sendMessage({
     channel: 0, // FromInjectedToService
     msg: {
       name: "on_media",
       data: { media: serialize(mediaObject) }
     }
   });
   ```

### Modificando a Interface (UI)
- O popup e o sidebar compartilham o mesmo controlador [`ui/app.js`](./ui/app.js) e folha de estilos [`ui/styles.css`](./ui/styles.css).
- Ao renderizar novos dados na lista de mídias, utilize métodos seguros do DOM (`textContent`, `createElement`, `replaceChildren`) para evitar riscos de XSS.
- Mantenha a preservação de foco e valores digitados pelo usuário durante as atualizações reativas de estado (`VIDEOGRAB_STATE_UPDATED`).

---

## 5. Validação e Testes Automatizados

Antes de submeter qualquer alteração:

1. **Checagem de Sintaxe**:
   Execute `node --check` em todos os módulos modificados:
   ```powershell
   Get-ChildItem -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
   ```
2. **Validação do Manifesto e Módulos**:
   Verifique se todos os caminhos do `manifest.json` existem e teste a serialização/parsing de M3U8:
   ```powershell
   node -e "
   const fs = require('fs');
   const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
   console.log('Manifest OK:', m.name, m.version);
   "
   ```
3. **Privacidade e Segurança**:
   **Nunca** introduza caminhos absolutos locais da máquina do usuário (ex: `C:\Users\...`) no código, documentação ou histórico do Git. Utilize caminhos relativos à raiz do repositório.

---

## 6. Fluxo de Instalação e Teste Manual no Navegador

1. Abra o navegador baseado em Chromium (Google Chrome, Microsoft Edge ou Brave).
2. Acesse `chrome://extensions/`.
3. Ative o **Modo do desenvolvedor** (*Developer mode*).
4. Clique em **Carregar sem compactação** (*Load unpacked*) e selecione a pasta raiz deste repositório (`video_grab`).
5. Acesse uma página contendo vídeo (YouTube, Vimeo, ou páginas com streams HLS `.m3u8` / DASH `.mpd`).
6. Abra o popup do **VideoGrab** na barra de ferramentas ou o painel lateral e teste o download e a conversão de áudio.
