const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

exports.handler = async (event, context) => {
  // --- LOG DI DEBUG AGGIUNTIVI ---
  console.log('drive-webhook function started');
  console.log('Event raw body:', event.body); // Questo mostrerà il body grezzo
  console.log('Event headers:', JSON.stringify(event.headers, null, 2)); // Questo mostrerà tutti gli header
  // ---------------------------------

  try {
    // Configurazione clients
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "text-embedding-004" });

    // Configurazione Google Drive API
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'] // Assicurati che l'account di servizio abbia i permessi corretti
    });

    const drive = google.drive({ version: 'v3', auth });

    // --- ESTRAZIONE fileId DAGLI HEADERS (MODIFICA CRITICA) ---
    // Google Drive spesso invia l'ID della risorsa negli header, non nel body per le notifiche 'watch'
    const fileId = event.headers['X-Goog-Resource-Id'] || event.headers['x-goog-resource-id'];

    if (!fileId) {
        console.error('Errore grave: ID risorsa (file/cartella) non trovato negli header X-Goog-Resource-Id del webhook. Il body potrebbe essere vuoto o non un JSON valido per questo tipo di notifica.');
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Missing X-Goog-Resource-Id in webhook headers. Event body might be empty or not a valid JSON for this notification type.' })
        };
    }
    console.log('Processed fileId from webhook headers:', fileId);

    // Controlla lo stato della risorsa per capire il tipo di evento (es. 'update', 'trash', 'delete')
    const resourceState = event.headers['X-Goog-Resource-State'] || event.headers['x-goog-resource-state'];
    console.log('Resource State:', resourceState);
    // -------------------------------------------------------------

    // --- LOGICA ESISTENTE PER METADATI ESTESI (SENZA CAMBIAMENTI) ---
    // Ottieni metadati del file, inclusi i parent folder per costruire il folder_path
    const metadata = await drive.files.get({
      fileId: fileId, // Questo userà il `fileId` estratto dagli headers
      fields: 'id,name,mimeType,modifiedTime,parents' // Richiedo anche 'parents'
    });

    // Costruisci il folder_path (semplificato)
    let folderPath = null;
    if (metadata.data.parents && metadata.data.parents.length > 0) {
      try {
        const parentFolder = await drive.files.get({
          fileId: metadata.data.parents[0],
          fields: 'name'
        });
        folderPath = `/${parentFolder.data.name}`;
      } catch (parentError) {
        console.warn(`Impossibile recuperare il nome della cartella genitore per ${fileId}:`, parentError.message);
        folderPath = null;
      }
    }

    // Estrazione dei tag (Esempio: potresti usare i customProperties o i nomi dei file per i tag)
    let tags = [];
    // ------------------------------------------------------------------

    // --- ESTRAZIONE CONTENUTO FILE (LOGICA ESISTENTE) ---
    const fileResponse = await drive.files.get({
      fileId: fileId,
      alt: 'media'
    });

    let textContent = '';
    const fileMimeType = metadata.data.mimeType;

    // Gestisci diversi tipi di file
    if (fileMimeType.includes('text/plain')) {
      textContent = fileResponse.data;
    } else if (fileMimeType.includes('application/pdf')) {
      console.warn(`Tipo di file non supportato per la parsificazione del contenuto: ${fileMimeType}. Saltando il contenuto.`);
      textContent = '';
    } else if (fileMimeType.includes('application/vnd.google-apps.document')) {
      const docResponse = await drive.files.export({
        fileId: fileId,
        mimeType: 'text/plain'
      });
      textContent = docResponse.data;
    } else {
      console.warn(`Tipo di file non supportato per l'estrazione del testo: ${fileMimeType}.`);
      textContent = '';
    }
    // ---------------------------------------------------

    // Crea chunks del testo
    const chunks = createChunks(textContent, 1000);

    // Processa ogni chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      // Se il chunk è vuoto (es. file non parsificabile), salta l'embedding
      if (!chunk.trim()) {
          console.warn(`Chunk vuoto per il file ${fileId}, chunk_index ${i}. Saltando embedding.`);
          continue;
      }
      
      // Crea embedding del chunk
      const result = await model.embedContent(chunk);
      const embedding = result.embedding.values;

      // Inserisci o aggiorna in Supabase (UPSERT)
      const { error } = await supabase
        .from('documents')
        .upsert({
          file_id: fileId,
          file_name: metadata.data.name,
          chunk_index: i,
          content: chunk,
          embedding: embedding,
          modified_time: metadata.data.modifiedTime,
          folder_path: folderPath,
          tags: tags
        });

      if (error) {
        console.error('Errore inserimento Supabase:', error);
      } else {
        console.log(`Documento ${fileId}, chunk ${i} inserito/aggiornato con successo.`);
      }
    }

    // Gestione della cancellazione (logica attuale: non implementata qui)

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'File processato con successo (o saltato se non supportato).' })
    };

  } catch (error) {
    console.error('Errore webhook generale:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Errore del server: ${error.message}` })
    };
  }
};

// Funzione helper per la creazione dei chunk
function createChunks(text, chunkSize) {
  const chunks = [];
  if (!text || text.length === 0) {
      return chunks;
  }
  const words = text.split(/\s+/);
  let currentChunk = [];
  let currentLength = 0;

  for (const word of words) {
    if (currentLength + word.length + 1 > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.join(' '));
      currentChunk = [];
      currentLength = 0;
    }
    currentChunk.push(word);
    currentLength += word.length + 1;
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(' '));
  }
  return chunks;
}