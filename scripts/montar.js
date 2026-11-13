// PLD ITAPITANGA — monta a pasta "public" que o Vercel publica.
// 1. copia o site;
// 2. se o Vercel tiver as variáveis NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
//    grava esses valores em js/pld-config.js (senão, mantém os que já estão no arquivo);
// 3. dá ao modo offline (sw.js) uma versão nova a cada publicação.
const fs = require("fs");
const path = require("path");

const raiz = path.join(__dirname, "..");
const saida = path.join(raiz, "public");
const FORA = new Set(["public", "node_modules", "scripts", "supabase", ".git", ".github", ".vercel",
  "package.json", "package-lock.json", "vercel.json", "README.md", ".env", ".env.example", ".gitignore"]);

// .env local (as variáveis do Vercel têm prioridade)
const arqEnv = path.join(raiz, ".env");
if (fs.existsSync(arqEnv)) {
  for (const linha of fs.readFileSync(arqEnv, "utf8").split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const chave = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (chave && (/^sb_secret_/.test(chave) || /service_role/.test(chave))) {
  console.error("A chave informada é SECRETA. Use a publishable key (sb_publishable_...).");
  process.exit(1);
}

fs.rmSync(saida, { recursive: true, force: true });
function copiar(de, para) {
  for (const nome of fs.readdirSync(de)) {
    if (de === raiz && FORA.has(nome)) continue;
    const a = path.join(de, nome), b = path.join(para, nome);
    if (fs.statSync(a).isDirectory()) { fs.mkdirSync(b, { recursive: true }); copiar(a, b); }
    else fs.copyFileSync(a, b);
  }
}
fs.mkdirSync(saida, { recursive: true });
copiar(raiz, saida);

if (url && chave) {
  fs.writeFileSync(path.join(saida, "js", "pld-config.js"),
    "/* PLD ITAPITANGA — gerado na publicação (Vercel). */\nwindow.PLD_SUPABASE = " +
    JSON.stringify({ url: url.replace(/\/+$/, ""), chave }, null, 2) + ";\n");
  console.log("Banco: " + url + " (variáveis do Vercel)");
} else {
  console.log("Banco: valores de js/pld-config.js (variáveis do Vercel não definidas)");
}

const versao = process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 10) : Date.now().toString(36);
const sw = path.join(saida, "sw.js");
fs.writeFileSync(sw, fs.readFileSync(sw, "utf8").replace(/var VERSAO = '([^']+)';/, "var VERSAO = '$1-" + versao + "';"));
console.log("PLD Itapitanga pronto em public/ · versão " + versao);
