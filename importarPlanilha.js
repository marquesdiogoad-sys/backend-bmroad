import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import csv from 'csv-parser';
import pool from './db.js';

const DOMINIOS_BLOQUEADOS = [
    '@agtdisplays.com.br', 
    '@agte.com.br', 
    '@infinitydobrasil.com.br'
];

function sanitizarCNPJ(cnpj) {
    if (!cnpj) return null;
    return String(cnpj).replace(/\D/g, ''); 
}

function filtrarEmails(emailBruto) {
    if (!emailBruto) return '';
    const emails = emailBruto.split(/[,;]/).map(e => e.trim());
    const emailsLimpos = emails.filter(email => {
        return !DOMINIOS_BLOQUEADOS.some(dominio => email.toLowerCase().includes(dominio));
    });
    return emailsLimpos.join('; ');
}

async function processarLinha(linha) {
    const cnpjBruto = linha.cnpj || '';
    if(!cnpjBruto || cnpjBruto.trim() === '') return; 

    const cnpjLimpo = sanitizarCNPJ(cnpjBruto);
    const emailsValidos = filtrarEmails(linha.email);
    
    let faturamento = linha.faturamento ? linha.faturamento.toString().replace(/\./g, '').replace(',', '.') : 0;
    if(isNaN(faturamento) || faturamento === '') faturamento = 0;

    const conexao = await pool.connect();

    try {
        await conexao.query('BEGIN'); 

        const queryEmpresa = `
            INSERT INTO empresas (razao_social, cnpj, cidade, uf, faturamento, classe_abc, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (cnpj) DO UPDATE SET 
                razao_social = EXCLUDED.razao_social,
                cidade = EXCLUDED.cidade,
                uf = EXCLUDED.uf,
                faturamento = EXCLUDED.faturamento,
                classe_abc = EXCLUDED.classe_abc,
                status = EXCLUDED.status
            RETURNING id;
        `;
        
        const valoresEmpresa = [
            linha.razao_social ? linha.razao_social.trim().toUpperCase() : null, // Alterado para null se vazio
            cnpjLimpo,
            linha.cidade ? linha.cidade.trim() : null,
            linha.uf ? linha.uf.trim().toUpperCase() : null,
            faturamento,
            linha.classe ? linha.classe.trim().toUpperCase() : 'SEM',
            'Inativo' 
        ];

        const resEmpresa = await conexao.query(queryEmpresa, valoresEmpresa);
        const empresaId = resEmpresa.rows[0].id;

        if (linha.telefone || emailsValidos !== '') {
            const queryContato = `
                INSERT INTO contatos (empresa_id, nome, telefone, email)
                VALUES ($1, $2, $3, $4)
            `;
            const valoresContato = [
                empresaId,
                'Contato Principal',
                linha.telefone ? linha.telefone.trim() : null,
                emailsValidos
            ];
            await conexao.query(queryContato, valoresContato);
        }

        await conexao.query('COMMIT'); 
        console.log(`✅ Atualizado: ${linha.razao_social || 'Empresa'} (CNPJ: ${cnpjLimpo})`);

    } catch (erro) {
        await conexao.query('ROLLBACK'); 
        console.error(`❌ Erro ao atualizar CNPJ ${cnpjLimpo}:`, erro.message);
    } finally {
        conexao.release();
    }
}

async function iniciarImportacao() {
    console.log('🚀 Iniciando atualização relacional (Filtro Anti-Acento Ativado)...\n');
    
    const promessas = [];
    let contador = 0;
    
    fs.createReadStream('clientes_importacao.csv')
        .pipe(csv({ 
            separator: ';', 
            mapHeaders: ({ header }) => {
                let h = header.replace(/^[\uFEFF\u200B]/g, '').trim().toLowerCase();
                
                // TRADUTOR DE CABEÇALHOS (À prova de falhas de codificação do Excel)
                if (h.includes('social')) return 'razao_social'; // Pula o 'ã' e procura só por 'social'
                if (h.includes('cidade')) return 'cidade';
                if (h.includes('e-mail') || h === 'email') return 'email';
                if (h.includes('telefone')) return 'telefone';
                if (h.includes('cnpj')) return 'cnpj';
                if (h.includes('classe')) return 'classe';
                if (h === 'uf') return 'uf';
                if (h.includes('faturamento')) return 'faturamento';
                
                return h;
            }
        }))
        .on('data', (linha) => {
            contador++;
            promessas.push(processarLinha(linha));
        })
        .on('end', async () => {
            await Promise.all(promessas); 
            console.log(`\n🏁 ATUALIZAÇÃO CONCLUÍDA! Foram reprocessadas ${contador} linhas.`);
            process.exit(0);
        });
}

iniciarImportacao();