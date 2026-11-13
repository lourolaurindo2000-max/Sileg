# PLD — Plenário Legislativo Digital · Câmara Municipal de Itapitanga-BA

Réplica do sistema do plenário (mesmo design e funções), **separada do sistema de Almadina**.
Banco de dados **Supabase** (projeto `PLD_Itapitanga`), com atualização em tempo real entre notebook, tablets e Smart TVs. Publicável no **Vercel** e no GitHub Pages.

Versão 1.0 · © 2026 Todos os direitos reservados a André Almeida, desenvolvedor do sistema.

## Banco de dados (Supabase)

Projeto: **PLD_Itapitanga** (`fbmmmpgaitglndlmyimh`, São Paulo). Não usa nenhum banco de Almadina.

| Tabela | Conteúdo |
| --- | --- |
| `pld_nos` | Todos os dados do sistema (votação, presença, controle de fala, sorteio, anotações, documentos) |
| `pld_log` | Registro de mudanças: avisa os aparelhos em tempo real |
| `pld_desconectar` | Marcações "ao desconectar" (tablet/notebook que saiu) |

- `js/pld-config.js`: endereço e chave **pública** do banco.
- `js/pld-banco.js`: liga as páginas ao Supabase (mesmas funções que o Firebase oferecia). Roda em Smart TVs antigas.
- `supabase/migrations/`: registro das tabelas e funções (já aplicadas no projeto).

O acesso é aberto (igual ao Firebase de Almadina): quem tem o endereço do site consegue ler e gravar pelas funções do sistema.

## Publicar no Vercel

1. No Vercel: **Add New → Project → Import** o repositório do GitHub (`Sileg`).
2. Framework: **Other**. O `vercel.json` já define o build (`npm run build`) e a pasta `public/`.
3. (Opcional) **Settings → Environment Variables**: `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   (se não definir, usa os valores de `js/pld-config.js`). Use sempre a **publishable key** (`sb_publishable_...`), nunca a secret.
4. Deploy.

No GitHub Pages funciona igual (usa `js/pld-config.js`).

## Smart TV (qualquer marca)

Abra uma vez, no navegador da TV: `ENDERECO-DO-SITE/dashboard.html#tv`.
Depois disso a TV segue sozinha o que o notebook abrir (Controle de Fala, Sorteio, Presença, Votação).
Se o tempo real não funcionar na TV, ela consulta o banco a cada 1,5 s.

## Sem internet

As alterações feitas sem conexão ficam guardadas no aparelho e são enviadas, na ordem, quando a internet volta.
