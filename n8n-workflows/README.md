# Workflows n8n

Guarda aqui as exportações JSON dos workflows usados pela aplicação.

Endpoints esperados pelo front-end:

- `sorteio-ficheiro`
- `torneio-criar`
- `torneio-equipas`
- `torneio-resultados`
- `torneio-classificacoes`
- `torneio-calendario`
- `torneio-exportar`

Depois do n8n estar online no Render:

1. Entra no serviço `dragonforce-n8n`.
2. Importa cada workflow JSON.
3. Confirma que cada Webhook node usa o path correto.
4. Ativa os workflows para disponibilizar os URLs de produção.
