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
Este projeto deve ser publicado como Static Site.

- Build Command: `npm ci && npm run build`
- Publish Directory: `dist`
- Environment Variable: `VITE_N8N_BASE_URL=https://teu-n8n-online.com/webhook`

O ficheiro `render.yaml` já inclui a configuração base para Blueprint no Render.

### Workflows n8n online
Em produção, o front-end não pode usar `127.0.0.1`. Define `VITE_N8N_BASE_URL` com o domínio público do teu n8n, mantendo `/webhook` no fim.

Exemplo:
```bash
VITE_N8N_BASE_URL=https://dragonforce-n8n.onrender.com/webhook
```

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
