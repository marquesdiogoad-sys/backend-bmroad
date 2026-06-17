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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const tools = [{
    functionDeclarations: [
        {
            name: "verificar_cliente",
            description: "Consulta o CNPJ para identificar se é cliente recorrente.",
            parameters: { type: "OBJECT", properties: { cnpj: { type: "STRING" } }, required: ["cnpj"] }
        },
        {
            name: "salvar_leads_cotacoes",
            description: "Salva os dados do lead na tabela leads_cotacoes.",
            parameters: {
                type: "OBJECT",
                properties: {
                    nome_contato: { type: "STRING" },
                    empresa: { type: "STRING" },
                    cnpj: { type: "STRING" },
                    telefone: { type: "STRING" },
                    rota_origem: { type: "STRING" },
                    rota_destino: { type: "STRING" },
                    peso_carga: { type: "STRING" },
                    volume_carga: { type: "STRING" },
                    valor_nf: { type: "STRING" }
                }
            }
        }
    ]
}];

const instrucoesSistema = `Você é a Isa, assistente da BM Road.
IDENTIDADE: Humana, prestativa, usa tom de conversa. Nunca soa robótica.
FLUXO:
1. Peça Empresa e CNPJ. Use 'verificar_cliente'. Se cliente antigo, cumprimente.
2. Peça Origem e Destino.
3. Peça Nome do Contato e Telefone.
4. Peça Peso, Volume e Valor da NF.
5. Ao ter tudo, use 'salvar_leads_cotacoes'.
REGRAS: 
- NÃO diga "Salvei no CRM". Apenas agradeça e diga que um consultor entrará em contato.`;

app.post('/api/chat', async (req, res) => {
    const { message, history } = req.body;
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2-flash", tools, systemInstruction: instrucoesSistema });
        const chat = model.startChat({ history: history });
        
        await delay(Math.floor(Math.random() * 1000) + 1500); 

        const result = await chat.sendMessage(message);
        let aiResponseText = result.response.text();
        const functionCalls = result.response.functionCalls;

        if (functionCalls) {
            for (const call of functionCalls) {
                if (call.name === "verificar_cliente") {
                    const resDb = await pool.query('SELECT empresa FROM leads_cotacoes WHERE cnpj = $1 LIMIT 1', [call.args.cnpj]);
                    const status = resDb.rows.length > 0 ? `Cliente recorrente: ${resDb.rows[0].empresa}` : "Cliente novo";
                    const response = await chat.sendMessage([{ functionResponse: { name: "verificar_cliente", response: { status } } }]);
                    aiResponseText = response.response.text();
                }
                if (call.name === "salvar_leads_cotacoes") {
                    const args = call.args;
                    await pool.query(
                        `INSERT INTO leads_cotacoes 
                        (nome_contato, empresa, cnpj, telefone, rota_origem, rota_destino, peso_carga, volume_carga, valor_nf) 
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                        [args.nome_contato, args.empresa, args.cnpj, args.telefone, args.rota_origem, args.rota_destino, args.peso_carga, args.volume_carga, args.valor_nf]
                    );
                    aiResponseText = "Perfeito, anotei tudo! Um dos nossos consultores entrará em contato em breve.";
                }
            }
        }
        res.json({ reply: aiResponseText, history: await chat.getHistory() });
    } catch (error) {
        console.error("Erro na API:", error);
        res.status(500).json({ reply: "A Isa está a recalibrar a rota, tente em um segundo!", history });
    }
});

app.listen(3000, () => console.log("Servidor ativo"));
