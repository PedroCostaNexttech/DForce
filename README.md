# Dragon Force Sorteios

Front-end em React + Vite para o motor de sorteios Dragon Force.

## Requisitos
- Node.js 18+
- npm

## Instalação
```bash
npm install
```

## Desenvolvimento
```bash
npm run dev
```

## Build
```bash
npm run build
```

## Deploy no Render
Este projeto está preparado para Blueprint no Render com dois serviços:

- `dragonforce-sorteios`: front-end React/Vite como Web Service Node.
- `dragonforce-n8n`: n8n como Web Service Docker com disco persistente.

O ficheiro `render.yaml` liga automaticamente o front-end ao URL público do n8n. Se criares manualmente no Render, usa estes campos para o serviço DForce:

- Language: `Node`
- Branch: `main`
- Root Directory: vazio
- Build Command: `npm ci && npm run build`
- Start Command: `npm start`
- Environment Variable: `N8N_BASE_URL=https://dragonforce-n8n.onrender.com`

O servidor Node serve a pasta `dist` e encaminha `/webhook/*` para o n8n configurado em `N8N_BASE_URL`.

Também podes usar `N8N_BASE_URL` com `/webhook` no fim; o servidor normaliza automaticamente.

### Workflows n8n online
Em produção, o front-end não pode usar `127.0.0.1`. O n8n precisa de estar online no Render e os workflows têm de ser importados/ativados nessa instância.

Depois do deploy do serviço `dragonforce-n8n`, entra no URL público do n8n, cria a conta inicial, importa os workflows e confirma que cada Webhook node está ativo em modo Production.

Os endpoints esperados são:
- `/sorteio-ficheiro`
- `/torneio-criar`
- `/torneio-equipas`
- `/torneio-resultados`
- `/torneio-classificacoes`
- `/torneio-calendario`
- `/torneio-exportar`

## Estrutura
- `src/App.jsx` - interface principal e integração com n8n
- `src/lib/notes.js` - parsing das notas e regras
- `src/styles.css` - estilos do layout
- `index.html` - entrada Vite
