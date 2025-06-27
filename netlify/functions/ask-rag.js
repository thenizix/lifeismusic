const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

exports.handler = async (event, context) => {
  // Gestisci CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  try {
    // Configurazione clients
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
    const chatModel = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      generationConfig: {
        maxOutputTokens: 1000, // Limita la lunghezza della risposta per controllo costi e concisione
      },
    });

    // Estrai la domanda dal body della richiesta
    const { question } = JSON.parse(event.body);

    if (!question) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Domanda mancante.' })
      };
    }

    // --- NUOVE FUNZIONALITÀ: Filtro Input Utente e FAQ-First ---

    // 1. Filtro/Normalizzazione Input Utente
    const cleanedQuestion = question.trim();
    if (cleanedQuestion.length < 5) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ answer: 'La domanda è troppo corta. Per favore, sii più specifico.', sources: [] })
      };
    }
    if (cleanedQuestion.toLowerCase().includes("ciao") || cleanedQuestion.toLowerCase().includes("salve")) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ answer: "Ciao! Sono qui per rispondere alle tue domande sui documenti. Come posso esserti d'aiuto?", sources: [] })
        };
    }
    // Puoi aggiungere altri filtri o risposte predefinite qui

    // 2. Strategia FAQ-First: Cerca prima nelle FAQ
    const { data: faqData, error: faqError } = await supabase
      .from('faqs')
      .select('answer')
      .ilike('question', `%${cleanedQuestion}%`) // Ricerca case-insensitive per somiglianza
      .limit(1); // Prendi solo la prima FAQ che corrisponde

    if (faqData && faqData.length > 0) {
      // Trovata una risposta nelle FAQ, restituiscila immediatamente
      console.log('Risposta trovata nelle FAQ.');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          answer: `(FAQ) ${faqData[0].answer}`, // Aggiungo (FAQ) per indicare la fonte
          sources: [] // Nessuna fonte RAG da documenti
        })
      };
    }

    // --- Fine NUOVE FUNZIONALITÀ ---

    // Se nessuna FAQ corrisponde, procedi con il processo RAG (come prima)
    console.log('Nessuna FAQ corrispondente, procedo con RAG...');

    // Crea embedding della domanda
    const questionEmbeddingResult = await embeddingModel.embedContent(cleanedQuestion);
    const questionEmbedding = questionEmbeddingResult.embedding.values;

    // Esegui similarity search su Supabase
    const { data, error } = await supabase.rpc('match_documents', {
      query_embedding: questionEmbedding,
      match_threshold: 0.75, // Puoi regolare questa soglia
      match_count: 5 // Numero di documenti rilevanti da recuperare
    });

    if (error) {
      console.error('Errore similarity search:', error);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Errore nella ricerca dei documenti.' })
      };
    }

    if (!data || data.length === 0) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ answer: 'Non ho trovato documenti rilevanti per la tua domanda. Prova a riformularla.', sources: [] })
        };
    }

    // Costruisci il contesto dai documenti trovati
    // Ora includiamo anche folder_path e tags nelle fonti se disponibili
    const context = data.map(doc => {
      let docContext = `File: ${doc.file_name} (Chunk ${doc.chunk_index})\nContenuto: ${doc.content}`;
      if (doc.folder_path) docContext += `\nCartella: ${doc.folder_path}`;
      if (doc.tags && doc.tags.length > 0) docContext += `\nTags: ${doc.tags.join(', ')}`;
      return docContext;
    }).join('\n\n');

    // Costruisci il prompt per Gemini
    const prompt = `
Sei un assistente esperto in musica e discografia, hai capacita'di management ed esperienza in editoria digitale marketing social.Audio video luci effetti, management artistico, comprendi lo stadio del progetto e ne sei co-responsabile con Admin. Se l utente si identifica con admin, collabora con lui all evoluzione del progetto rispondendo a qualsiasi tipo di domanda anche fuori dall ambito del progetto. Per tutti gli altri utenti rispondi  Basandoti **SOLO ed esclusivamente** sui seguenti documenti forniti, rispondi alla domanda dell'utente in modo accurato, dettagliato e professionale.
DOCUMENTI RILEVANTI:
${context}

DOMANDA DELL'UTENTE: ${cleanedQuestion}

RISPOSTA:`;

    // Chiama Gemini per generare la risposta
    const result = await chatModel.generateContent(prompt);
    const response = result.response;
    const answer = response.text();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        answer: answer,
        sources: data.map(doc => ({
          file_name: doc.file_name,
          chunk_index: doc.chunk_index, // Aggiunto chunk_index per maggiore dettaglio
          similarity: doc.similarity,
          folder_path: doc.folder_path, // Aggiunto folder_path
          tags: doc.tags // Aggiunto tags
        }))
      })
    };

  } catch (error) {
    console.error('Errore ask-rag:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: `Errore del server: ${error.message}` })
    };
  }
};