# 🛡️ Rinha de Backend 2026 — Fraud Detection API

> Um detector de fraude em tempo real construído sobre **vetorização + busca vetorial (k-NN)**, rodando em **1 CPU / 350 MB** com dois nós Node.js atrás do nginx.

[![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white)](.nvmrc)
[![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)](https://fastify.dev)
[![Vitest](https://img.shields.io/badge/Vitest-4-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev)
[![nginx](https://img.shields.io/badge/nginx-1.27-009639?logo=nginx&logoColor=white)](nginx.conf)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Submissão para a **[Rinha de Backend 2026](https://github.com/zanfranceschi/rinha-de-backend-2026)** — uma API HTTP que recebe transações de cartão e responde, em milissegundos, se a transação deve ser **aprovada** e qual o seu **score de fraude**.

---

## ✨ Visão geral

Cada requisição é transformada em um **vetor de 14 dimensões** normalizado e comparado, via **k-NN (k=5)**, contra um conjunto de referência rotulado (`fraud` / `legit`) de ~3 milhões de vetores. O score é a fração de vizinhos fraudulentos:

```
fraud_score = (fraudes entre os k vizinhos mais próximos) / k
approved    = fraud_score < 0.6
```

Para servir essa busca dentro do orçamento da Rinha, o conjunto de referência é **pré-processado em build time** num índice **IVF** (Inverted File Index) e carregado em memória **compartilhada** (`SharedArrayBuffer`), consultada por um **pool de workers**.

---

## 🏗️ Arquitetura

```
                         ┌──────────────────────────┐
   POST /fraud-score     │         nginx            │   round-robin
   ──────────────────▶   │   (load balancer :9999)  │   keepalive
                         └────────────┬─────────────┘
                              ┌────────┴────────┐
                              ▼                 ▼
                       ┌────────────┐    ┌────────────┐
                       │   api1     │    │   api2     │   Fastify 5
                       │ (Fastify)  │    │ (Fastify)  │
                       └─────┬──────┘    └─────┬──────┘
                             │                 │
                   vectorize │ + score()       │
                             ▼                 ▼
                    ┌─────────────────────────────────┐
                    │  Índice IVF em SharedArrayBuffer │
                    │  consultado por um pool de       │
                    │  worker_threads (k-NN)           │
                    └─────────────────────────────────┘
```

| Componente | Papel |
|---|---|
| **nginx** | Balanceia round-robin entre `api1`/`api2`. Sem lógica de negócio — só encaminha. |
| **Fastify** | Servidor HTTP + validação estrita do payload via JSON Schema (AJV). |
| **vectorize** | Converte o payload validado no vetor normalizado de 14 dimensões. |
| **k-NN / IVF** | Busca os vizinhos mais próximos no índice e calcula `fraud_score`. |
| **worker pool** | `worker_threads` consultando o índice em memória compartilhada (uma cópia, não por worker). |

### Dois caminhos de execução

A lógica de scoring degrada de forma transparente conforme o ambiente:

- **Produção** — quando os binários do índice (`vectors.bin`, `labels.bin`, `ivf.bin`) existem em `resources/`, o serviço sobe o pool de workers sobre o índice IVF. O `/ready` responde **503** enquanto carrega e **200** quando o pool está pronto.
- **Naive (test/dev)** — sem os binários, cai num brute-force síncrono sobre o conjunto de exemplo (`example-references.json`). É o que mantém os testes rápidos e sem dependência de build.

---

## 📡 API

A API expõe exatamente **dois endpoints na porta 9999**.

### `GET /ready`

Readiness probe. Retorna `200` quando o serviço pode atender e `503` enquanto o índice ainda está carregando.

```bash
curl -i http://localhost:9999/ready
# 503 {"status":"loading"}   → ainda subindo
# 200 {"status":"ok"}        → pronto
```

### `POST /fraud-score`

Recebe uma transação e retorna a decisão.

**Request**

```bash
curl -X POST http://localhost:9999/fraud-score \
  -H "Content-Type: application/json" \
  -d '{
    "id": "tx-1329056812",
    "transaction": { "amount": 41.12, "installments": 2, "requested_at": "2026-03-11T18:45:53Z" },
    "customer":    { "avg_amount": 82.24, "tx_count_24h": 3, "known_merchants": ["MERC-003", "MERC-016"] },
    "merchant":    { "id": "MERC-016", "mcc": "5411", "avg_amount": 60.25 },
    "terminal":    { "is_online": false, "card_present": true, "km_from_home": 29.2331036248 },
    "last_transaction": null
  }'
```

**Response**

```json
{ "approved": true, "fraud_score": 0.2 }
```

#### Validação estrita

O AJV é configurado com `removeAdditional: false` e `coerceTypes: false`, e o schema usa `additionalProperties: false` em todos os níveis. Isso é deliberado:

- propriedades desconhecidas → **400**
- tipos incompatíveis (ex.: string numérica onde se espera número) → **400** (sem coerção silenciosa)
- `last_transaction` é anulável (`object | null`); os campos internos só são obrigatórios quando é um objeto.

#### As 14 dimensões do vetor

| # | Dimensão | Origem / normalização |
|---|---|---|
| 0 | `amount` | `amount / max_amount` |
| 1 | `installments` | `installments / max_installments` |
| 2 | `amount_vs_avg` | `(amount / avg_amount) / ratio` |
| 3 | `hour_of_day` | hora UTC `/ 23` |
| 4 | `day_of_week` | seg=0…dom=6, `/ 6` |
| 5 | `minutes_since_last_tx` | desde a tx anterior (`-1` se não há) |
| 6 | `km_from_last_tx` | distância da tx anterior (`-1` se não há) |
| 7 | `km_from_home` | `km_from_home / max_km` |
| 8 | `tx_count_24h` | `tx_count_24h / max_tx_count_24h` |
| 9 | `is_online` | 0 / 1 |
| 10 | `card_present` | 0 / 1 |
| 11 | `unknown_merchant` | 1 se o lojista **não** é conhecido do cliente |
| 12 | `mcc_risk` | peso de risco por MCC (0–1) |
| 13 | `merchant_avg_amount` | `merchant.avg_amount / max_merchant_avg_amount` |

Valores são clampados em `[0, 1]` (exceto o sentinela `-1` para "dado ausente") e arredondados a 4 casas. As constantes vivem em [`resources/normalization.json`](resources/normalization.json) e [`resources/mcc_risk.json`](resources/mcc_risk.json).

---

## 🚀 Começando

### Pré-requisitos

- Node.js **v24** (veja [`.nvmrc`](.nvmrc) — `nvm use`)
- Docker + Docker Compose (para o ambiente completo)

### Rodando localmente (sem Docker)

```bash
npm install
node src/index.js          # sobe na porta 9999 (modo naive, sem índice IVF)
```

### Rodando o ambiente completo (nginx + 2 APIs, com os limites reais)

```bash
docker compose up --build

# em outro terminal:
curl -i http://localhost:9999/ready
docker stats --no-stream   # confere o budget: ≤ 1 CPU / 350 MB
```

> O build é multi-stage: o estágio de build roda `scripts/preprocess.js`, que lê o conjunto completo (`resources/references.json.gz`, ~50 MB), faz k-means + atribuição e gera o índice IVF (`vectors.bin`, `labels.bin`, `ivf.bin`). Esse custo é pago **só no build** — a imagem final não carrega o `.gz`.

---

## 🧪 Testes

```bash
npm test                              # Vitest em watch mode
npx vitest run                        # roda tudo uma vez (CI)
npx vitest run -t "rejects amount"    # filtra por nome
```

Os testes importam o **app factory** (`buildApp`) e exercitam as rotas via `app.inject(...)`, sem abrir porta. Cobrem: validação estrita do payload, a vetorização das 14 dimensões e a lógica de k-NN.

---

## 📁 Estrutura do projeto

```
src/
├── index.js                     # entrypoint: buildApp() + listen(9999)
├── config/app.js                # app factory (Fastify + rotas), usado nos testes
├── validation/
│   └── fraud-score-schema.js    # JSON Schema (body + response) do /fraud-score
└── scoring/
    ├── vectorize.js             # payload → vetor 14-dim normalizado
    ├── knn.js                   # k-NN: caminho naive + pool de workers / IVF
    └── worker.js                # worker_thread que consulta o índice

scripts/
├── preprocess.js                # gera o índice IVF a partir do .gz (build time)
└── ivf-core.js                  # núcleo do índice IVF (compartilhado runtime/build)

resources/                       # dados de referência e constantes de normalização
test/                            # specs Vitest (fraud-score, vectorize, knn)
benchmark/recall.js              # avaliação de recall da busca vetorial
docs/                            # documentação detalhada (arquitetura, dataset, regras…)
```

> 📚 A pasta [`docs/`](docs/) contém documentação aprofundada: arquitetura, dataset, regras de detecção, busca vetorial, avaliação e guia de submissão.

---

## ⚙️ Stack & convenções

- **Node.js v24**, ESM (`"type": "module"` — `import`/`export`, sem `require`).
- **Fastify 5** no servidor, **Vitest** nos testes.
- Código, comentários e descrições de teste em **inglês**.
- Imagem **multi-stage**, balanceada por **nginx**, dentro de **1 CPU / 350 MB**.

---

## 📦 Deploy & submissão

O passo a passo completo de build, publicação da imagem no Docker Hub e preparação da branch `submission` está em **[DEPLOY.md](DEPLOY.md)**.

---

## 👤 Autor

**Renan Oliveira** — [@Renan04lima](https://github.com/Renan04lima)

## 📄 Licença

Distribuído sob a licença **MIT**. Veja [LICENSE](LICENSE).
