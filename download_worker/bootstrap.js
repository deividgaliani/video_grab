/**
 * VideoGrab — Ponto de entrada do download_worker
 * Instala os hooks de fetch antes de carregar o motor de download (main.js).
 * A ordem dos imports é significativa: módulos são avaliados na ordem declarada.
 */

import "./fetch_hooks.js";
import "./main.js";
