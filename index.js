const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 5432,
});

// Helper para simular tempo de resposta humano (1.5s a 2.5s)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setupDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS leads (
                id SERIAL PRIMARY KEY,
                nome_empresa VARCHAR(255),
                cnpj VARCHAR(50),
                nome_pessoa VARCHAR(255),
                telefone VARCHAR(50),
                origem VARCHAR(255),
                destino VARCHAR(255),
                peso VARCHAR(50),
                volume VARCHAR(255),
                valor_nf VARCHAR(50),
                recorrencia VARCHAR(50),
                data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Tabela de CRM pronta.");
    } catch (err) { console.error("Erro no DB:", err); }
}
setupDatabase();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const tools = [{
    functionDeclarations: [
        {
            name: "verificar_cliente",
            description: "Consulta o CNPJ para identificar se é cliente recorrente.",
            parameters: { type: "OBJECT", properties: { cnpj: { type: "STRING" } }, required: ["cnpj"] }
        },
        {
            name: "salvar_lead_crm",
            description: "Salva os dados do lead no final do atendimento.",
            parameters: {
                type: "OBJECT",
                properties: {
                    nome_empresa: { type: "STRING" }, cnpj: { type: "STRING" },
                    nome_pessoa: { type: "STRING" }, telefone: { type: "STRING" },
                    origem: { type: "STRING" }, destino: { type: "STRING" },
                    peso: { type: "STRING" }, volume: { type: "STRING" },
                    valor_nf: { type: "STRING" }, recorrencia: { type: "STRING" }
                }
            }
        },
        {
            name: "calcular_frete",
            description: "Calcula o valor do frete. EM CONSTRUÇÃO.",
            parameters: { type: "OBJECT", properties: { peso: { type: "STRING" }, origem: { type: "STRING" }, destino: { type: "STRING" } } }
        }
    ]
}];

const instrucoesSistema = `
Você é a Isa, assistente da BM Road Transportes. 
IDENTIDADE: Humana, prestativa, usa tom de conversa. Nunca soa robótica.
FLUXO:
1. Peça Empresa e CNPJ. Use 'verificar_cliente'. Se cliente antigo, cumprimente.
2. Peça Origem e Destino.
3. Peça Nome da Pessoa e Telefone.
4. Peça Peso, Volume, Valor da NF e se a carga é recorrente ou única.
5. Ao ter tudo, use 'salvar_lead_crm'.
REGRAS: 
- NÃO diga "Salvei no CRM". Apenas agradeça e diga que um consultor entrará em contato.
- Se perguntarem sobre preço, use a ferramenta 'calcular_frete'.
`;

app.post('/api/chat', async (req, res) => {
    const { message, history } = req.body;
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", tools, systemInstruction: instrucoesSistema });
        const chat = model.startChat({ history: history });
        
        // Simulação de tempo de "pensamento" humano
        await delay(Math.floor(Math.random() * 1000) + 1500); 

        const result = await chat.sendMessage(message);
        let aiResponseText = result.response.text();
        const functionCalls = result.response.functionCalls;

        if (functionCalls) {
            for (const call of functionCalls) {
                if (call.name === "verificar_cliente") {
                    const resDb = await pool.query('SELECT nome_empresa FROM leads WHERE cnpj = $1 LIMIT 1', [call.args.cnpj]);
                    const status = resDb.rows.length > 0 ? `Cliente recorrente: ${resDb.rows[0].nome_empresa}` : "Cliente novo";
                    const response = await chat.sendMessage([{ functionResponse: { name: "verificar_cliente", response: { status } } }]);
                    aiResponseText = response.response.text();
                }
                if (call.name === "salvar_lead_crm") {
                    const args = call.args;
                    await pool.query('INSERT INTO leads (nome_empresa, cnpj, nome_pessoa, telefone, origem, destino, peso, volume, valor_nf, recorrencia) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', 
                        [args.nome_empresa, args.cnpj, args.nome_pessoa, args.telefone, args.origem, args.destino, args.peso, args.volume, args.valor_nf, args.recorrencia]);
                    aiResponseText = "Perfeito, anotei tudo! Um dos nossos consultores entrará em contato em breve.";
                }
                if (call.name === "calcular_frete") {
                    // TODO: AQUI É ONDE VOCÊ VAI INSERIR SUA LÓGICA DE CÁLCULO
                    aiResponseText = "Estou processando a rota... Como o sistema de cálculo ainda está em construção, anotei seu pedido e um especialista enviará o valor exato em breve!";
                }
            }
        }
        res.json({ reply: aiResponseText, history: await chat.getHistory() });
    } catch (error) {
        res.status(500).json({ reply: "A Isa está a recalibrar a rota, tente em um segundo!", history });
    }
});

app.listen(3000, () => console.log("Servidor ativo"));
