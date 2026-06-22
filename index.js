import  express  from  'express' ;
import  cors  from  'cors' ;
import  dotenv  from  'dotenv' ;
import  {  GoogleGenerativeAI  }  from  '@google/generative-ai' ;
import  pool  from  './db.js' ;
import  {  isaSystemInstruction  }  from  './isaPrompt.js' ;
dotenv.config ( ) ;​​
const  app  =  express ( ) ;
app.use ( cors ( ) ) ;​​
app.use ( express.json ( ) ) ;​​​​
const  genAI  =  new  GoogleGenerativeAI ( process . env . GEMINI_API_KEY ) ;
const  ferramentas  =  [ {
    declaraçõesDeFunção : [ {
        nome : "salvar_dados_crm" ,
        description : "Guarda as informações do lead. Chame silenciosamente quando extrair dados." ,
        parâmetros : {
            tipo : "OBJETO "
            propriedades : {
                cnpj : {  type : "STRING" ,  description : "CNPJ da empresa (apenas números ou formato padrão)"  } ,
                empresa : {  type : "STRING" ,  description : "Nome da empresa"  } ,
                rota_origem : {  type : "STRING" ,  description : "Cidade/Estado de origem"  } ,
                rota_destino : {  type : "STRING" ,  description : "Cidade/Estado de destino"  } ,
                nome_contato : {  type : "STRING" ,  description : "Nome do cliente com quem está a falar"  } ,
                telefone : {  type : "STRING" ,  description : "Telefone ou WhatsApp do cliente com DDD"  } ,
                peso_carga : {  type : "STRING" ,  description : "Peso estimado da carga"  } ,
                volume_carga : {  type : "STRING" ,  description : "Volume ou dimensões da carga"  } ,
                valor_nf : {  type : "NUMBER" ,  description : "Valor da Nota Fiscal (apenas números)"  }
            }
        }
    } ]
} ] ;
// --- FUNÇÕES DE VALIDAÇÃO (SEGURANÇA) ---
// 1. Valida Telefone Fixo (10 dígitos) ou Celular (11 dígitos) com DDD e Filtro Anti-Lixo
function  validarTelefoneBR ( telefone )  {
    se  ( ! telefone )  retornar  verdadeiro ; 
    const  números  =  telefone . substituir ( / \D / g ,  '' ) ; 
    
    // Verifica o tamanho
    if  ( números . comprimento  ! ==  10  &&  números . comprimento  ! ==  11 )  retorna  falso ;
    
    // Verificar DDD2
    const  ddd  =  parseInt ( numeros . substring ( 0 ,  2 ) ) ;
    se  ( ddd  <  11  ||  ddd  >  99 )  retorne  falso ;
    //Se for celular (11 dígitos), o terceiro dígito tem que ser obrigatoriamente 9
    if  ( números . comprimento  ===  11  &&  números . charAt ( 2 )  ! ==  '9' )  retorna  falso ;
    
    // FILTRO ANTI-PREGUIÇA: Bloqueia números onde todos os dígitos após o DDD são iguais (ex: 11999999999)
    const  numeroSemDDD  =  numeros.substring ( 2 ) ;​​
    const  todosIguais  =  / ^ ( \d ) \1 + $ / . test ( numeroSemDDD ) ;
    se  ( todosIguais )  retornar  falso ;
    
    // Bloqueia sequências clássicas de teste
    se  ( numeroSemDDD  ===  '123456789'  ||  numeroSemDDD  ===  '12345678' )  retorne  falso ;
    retornar  verdadeiro ;
}
// 2. Consulta CNPJ na BrasilAPI
 função  assíncrona consultarCNPJ ( cnpjOriginal )  {
    if  ( ! cnpjOriginal )  return  {  valido : true  } ;  // Passa se não tem inveja
    const  cnpjNumeros  =  cnpjOriginal.replace ( / \ D / g , ' ' ) ; 
    if  ( cnpjNumeros . length  !==  14 )  return  {  valido : false ,  erro : "O CNPJ precisa ter 14 números."  } ;
    tentar  {
        const  response  =  await  fetch ( `https://brasilapi.com.br/api/cnpj/v1/ ${ cnpjNumeros } ` ) ;
        if  ( ! resposta . ok )  return  {  valido : false ,  erro : "CNPJ não encontrado na Receita Federal."  } ;
        const  data  =  await  response.json ( ) ;​​
        return  {  valido : true ,  razão_social : dados . razão_social  } ;
    }  catch  ( erro )  {
        console . erro ( "Erro na BrasilAPI:" ,  erro ) ;
        return  {  valido : verdadeiro  } ;  // Se a API cair, deixamos passar para não bloquear a venda
    }
}
// --- ROTA PRINCIPAL DO CHAT ---
app.post ( '/api/chat ' , async ( req , res ) = > {     
    const  userMessage  =  req.body.message ;​​​​
    const  history  =  req.body.history || [ ] ;​​​​  
    const  threadId  =  req.body.threadId || ` sessao_ $ { Date.now ( ) } ` ;​​​​   

    tentar  {
        const  model  =  genAI.getGenerativeModel ( {​​
            modelo : "gemini- 1.5 -flash" ,  // Modelo ultra-rápido e econômico
            modelo : "gemini- 2.5 -flash" ,  // Modelo ultra-rápido e econômico
            ferramentas : ferramentas ,
            systemInstruction : é umaSystemInstruction ,
        } ) ;
        const  chat  =  model.startChat ( { history : history } ) ;​​  
        const  result  =  await  chat.sendMessage ( userMessage ) ;​​
        
        let  aiResponseText  =  result.response.text ( ) ;​​​​
        const  functionCalls  =  result.response.functionCalls ( ) ;​​​​ 
        se  ( functionCalls  &&  functionCalls.length > 0 ) {​​   
            const  call  =  functionCalls [ 0 ] ;
            
            if  ( chamar.nome === " salvar_dados_crm " ) {   
                const  args  =  call.args ;​​
                let  mensagemParaIA  =  "Dados atualizados. Faça a próxima pergunta natural do funil." ;
                let  podeSalvar  =  true ;
                //BLOCO DE VALIDAÇÃO DE SEGURANÇA
                if  ( args . telefone  &&  ! validarTelefoneBR ( args . telefone ) )  {
                    podeSalvar  =  falso ;
                    mensagemParaIA  =  "ERRO DE VALIDAÇÃO: Diga ao cliente que o telefone parece inválido e peça para ele digitar com DDD corretamente." ;
                }
                if  ( podeSalvar  &&  args . cnpj )  {
                    const  validacaoCnpj  =  await  consultarCNPJ ( args.cnpj ) ;​​
                    if  ( ! validacaoCnpj . valido )  {
                        podeSalvar  =  falso ;
                        mensagemParaIA  =  `ERRO DE VALIDAÇÃO: ${ validacaoCnpj . erro } Peça ao cliente para verificar o número digitado.` ;
                    }  else  if  ( validacaoCnpj.razao_social ) {​​ 
                        argumentos . empresa  =  validacaoCnpj . razão_social ;  // Preenchimento automático do nome correto da empresa
                    }
                }
                // SÓ SALVA NO BANCO SE AS VALIDAÇÕES PASSAREM
                se  ( podeSalvar )  {
                    const  queryVerifica  =  'SELECT id FROM leads_cotacoes WHERE thread_id = $1' ;
                    const  resVerifica  =  await  pool.query ( queryVerifica , [ threadId ] ) ;​​ 
                    se  ( resVerifica . linhas . comprimento  >  0 )  {
                        aguarde  pool.query ( `​​
                            ATUALIZAÇÃO leads_cotacoes
                            DEFINIR
                                cnpj = COALESCE($1, cnpj),
                                empresa = COALESCE($2, empresa),
                                rota_origem = COALESCE($3, rota_origem),
                                rota_destino = COALESCE($4, rota_destino),
                                nome_contato = COALESCE($5, nome_contato),
                                telefone = COALESCE($6, telefone),
                                peso_carga = COALESCE($7, peso_carga),
                                volume_carga = COALESCE($8, volume_carga),
                                valor_nf = COALESCE($9, valor_nf),
                                data_atualização = CURRENT_TIMESTAMP
                            ONDE thread_id = $10
                        ` ,  [ args . cnpj ,  args . empresa ,  args . rota_origem ,  args . rota_destino ,  args . nome_contato ,  args . telefone ,  args . peso_carga ,  args . volume_carga ,  args . valor_nf ,  threadId ] ) ;
                    }  outro  {
                        aguarde  pool.query ( `​​
                            INSERIR EM leads_cotacoes
                            (cnpj, empresa, rota_origem, rota_destino, nome_contato, telefone, peso_carga, volume_carga, valor_nf, thread_id)
                            VALORES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                        ` ,  [ args . cnpj ,  args . empresa ,  args . rota_origem ,  args . rota_destino ,  args . nome_contato ,  args . telefone ,  args . peso_carga ,  args . volume_carga ,  args . valor_nf ,  threadId ] ) ;
                    }
                }
                // Devolver uma resposta (Sucesso ou Erro de Validação) para a IA analisar e falar com o humano
                const  functionResponseResult  =  await  chat.sendMessage ( [ {​​
                    respostaDaFunção : { 
                        nome : "salvar_dados_crm" , 
                        resposta : {  sucesso : podeSalvar ,  instrução : mensagemParaIA  } 
                    }
                } ] ) ;
                aiResponseText  =  functionResponseResult.response.text ( ) ;​​​​
            }
        }
        const  updatedHistory  =  await  chat.getHistory ( ) ;​​
        res.json ( { reply : aiResponseText , history : updatedHistory , threadId : threadId } ) ;​​    
    }  catch  ( erro )  {
        console . error ( "🚨 Erro na API do Chat:" ,  erro ) ;
        res . estado ( 500 ) . json ( {  reply : "Peço imensa desculpa, estou a ter uma pequena falha de conexão. Podemos retomar?" , history , threadId } ) ;
    }
} ) ;
// --- FUNÇÃO AUXILIAR: VALIDAÇÃO DE E-MAIL CORPORATIVO ---
função  isEmailCorporativo ( email )  {
    const  fornecedoresGratuitos  =  [
        'gmail.com' ,  'hotmail.com' ,  'outlook.com' ,  'yahoo.com' , 
        'yahoo.com.br' ,  'bol.com.br' ,  'uol.com.br' ,  'ig.com.br' , 
        'icloud.com' ,  'msn.com'
    ] ;
    const  domínio  =  email . dividir ( '@' ) [ 1 ] ;
    if  ( ! dominio )  retorna  falso ;
    retornar  ! provedoresGratuitos . inclui ( domínio.toLowerCase ( ) ) ;​​
}
// --- ROTA DO FORMULÁRIO ESTÁTICO DO SITE ---
app.post ( ' / api/formulario' , async ( req , res ) = > {     
    const  { nome , email , telefone , cnpj , necessidade , mensagem }  =  req . corpo ;
    const  threadId  =  `form_ ${ Data . agora ( ) } ` ;  // Identificador único da cotação
    tentar  {
        // 1. VALIDAÇÃO DE E-MAIL CORPORATIVO
        se  ( ! isEmailCorporativo ( email ) )  {
            // Se for e-mail gratuito, bloquear e avisar o Frontend
            retornar  res.status ( 400 ) .json ( {​​​ 
                sucesso : falso , 
                mensagem : 'Por favor, utilize um e-mail corporativo válido para solicitar a cotação.' 
            } ) ;
        }
        // 2. BUSCA INTELIGENTE DE CNPJ (Receita Federal)
        let  empresaReal  =  'Não informada' ;
        deixe  cnpjLimpo  =  cnpj ? cnpj . substituir ( / \D / g ,  '' ) : null ;
        se  ( cnpjLimpo  &&  cnpjLimpo.comprimento === 14 ) {​​   
            // Reaproveitamos a função consultarCNPJ que já criamos para a Isa!
            const  validacao  =  await  consultarCNPJ ( cnpjLimpo ) ; 
            if  ( validação . valido  &&  validação . razão_social )  {
                empresaReal  =  validação . razão_social ;  // Preenchimento automático com o nome oficial!
            }
        }
        // 3. SALVAR NO POSTGRESQL (Agora com a coluna "email" dedicada)
        const  observacoes  =  `Mensagem original do cliente: ${ mensagem } ` ;
        aguarde  pool.query ( `​​
            INSERIR EM leads_cotacoes
            (nome_contato, empresa, cnpj, telefone, email, tipo_mercadoria, particularidades, canal_origem, status, thread_id)
            VALORES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ` ,  [
            nome , 
            empresaReal , 
            cnpjLimpo , 
            telefone ,
            email ,  // <-- A nossa nova coluna em ação
            necessidade , 
            observatórios , 
            'Site do Formulário' , 
            'Novo Lead' , 
            ID da thread
        ] ) ;
        // 4. SISTEMA DE NOTIFICAÇÃO (Gatilho)
        console . log ( `🔔 NOTIFICAÇÃO: Novo lead B2B de Alta Intenção! Empresa: ${ empresaReal } | Contato: ${ nome } ` ) ;
        // TODO: Adicionar o webhook para envio de mensagem para o WhatsApp do Gestor
        // Tudo certo! Responda com sucesso para o Site.
        res . estado ( 200 ) . json ( {  sucesso : verdadeiro ,  mensagem : 'Proposta solicitada com sucesso!'  } ) ;
    }  catch  ( erro )  {
        console . error ( "🚨 Erro na API do Formulário:" ,  erro ) ;
        res . estado ( 500 ) . json ( {  sucesso : false ,  mensagem : 'Ocorreu um erro interno ao processar a cotação.'  } ) ;
    }
} ) ;
aplicativo . get ( '/' , ( req , res ) => res .send (  ' 🚀 Motor  IA BM  Road  : Blindado e Operacional!' ) ) ;
const  PORTA  =  process.env.PORTA || 3000 ;​​​​  
aplicativo . listen ( PORT ,  ( )  =>  console.log ( ` Servidor na porta ${ PORT } ` ) ) ;
