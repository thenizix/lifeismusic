const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

exports.handler = async (event, context) => {
  // *** AGGIUNGI QUESTE DUE RIGHE QUI, ALL'INIZIO DELLA FUNZIONE exports.handler ***
  console.log('drive-webhook function started');
  console.log('Event body:', event.body);
  // ********************************************************************************

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

    // Estrai file ID dal webhook di Google Drive
    const notification = JSON.parse(event.body);
    const fileId = notification.resourceId; // L'ID del file che è stato modificato/creato

    // --- NUOVE FUNZIONALITÀ: Gestione Cancellazione e Metadati Estesi ---

    // Google Drive webhook invia notifiche per vari tipi di eventi.
    // Dobbiamo verificare se l'evento è una cancellazione.
    // L'identificazione di una cancellazione da Google Drive webhook è più complessa e spesso richiede il polling
    // del Change Feed API di Drive. Per ora, ci concentriamo su creazione/modifica.
    // Se un file viene cancellato da Drive, non verrà processato qui.
    // La gestione completa delle cancellazioni richiede un meccanismo separato e più robusto.

    // Ottieni metadati del file, inclusi i parent folder per costruire il folder_path
    const metadata = await drive.files.get({
      fileId: fileId,
      fields: 'id,name,mimeType,modifiedTime,parents' // Richiedo anche 'parents'
    });

    // Costruisci il folder_path (semplificato)
    let folderPath = null;
    if (metadata.data.parents && metadata.data.parents.length > 0) {
      // Per una completa path, dovresti ricorsivamente chiamare drive.files.get per ogni parent.
      // Qui prendiamo solo il primo parent ID per semplicità e lo usiamo come base.
      // Se hai una struttura folder più complessa, questa logica andrebbe espansa.
      try {
        const parentFolder = await drive.files.get({
          fileId: metadata.data.parents[0],
          fields: 'name'
        });
        folderPath = `/${parentFolder.data.name}`; // Esempio: "/NomeCartella"
        // Per percorsi completi tipo /root/folderA/subfolderB, è richiesta logica ricorsiva.
      } catch (parentError) {
        console.warn(`Impossibile recuperare il nome della cartella genitore per ${fileId}:`, parentError.message);
        folderPath = null;
      }
    }

    // Estrazione dei tag (Esempio: potresti usare i customProperties o i nomi dei file per i tag)
    // Per un sistema robusto, dovresti definire come i tag vengono associati ai file in Google Drive.
    // Per esempio, se i file sono nominati "documento_[tag1]_[tag2].pdf"
    let tags = [];
    // const filenameLower = metadata.data.name.toLowerCase();
    // if (filenameLower.includes('[finanza]')) tags.push('finanza');
    // if (filenameLower.includes('[q2]')) tags.push('Q2');

    // --- Fine NUOVE FUNZIONALITÀ ---

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
      // Per PDF, avresti bisogno di una libreria di parsificazione PDF (es. pdf-parse)
      // Che però non è inclusa di default in un ambiente Netlify Functions semplice.
      // Per ora, salta i PDF o convertili in testo prima del caricamento in Drive.
      console.warn(`Tipo di file non supportato per la parsificazione del contenuto: ${fileMimeType}. Saltando il contenuto.`);
      textContent = ''; // O un messaggio di errore
    } else if (fileMimeType.includes('application/vnd.google-apps.document')) {
      // Per Google Docs
      const docResponse = await drive.files.export({
        fileId: fileId,
        mimeType: 'text/plain'
      });
      textContent = docResponse.data;
    } else {
        // Per altri tipi di file non gestiti
        console.warn(`Tipo di file non supportato per l'estrazione del testo: ${fileMimeType}.`);
        textContent = '';
    }

    // Crea chunks del testo (dividi in sezioni più piccole)
    const chunks = createChunks(textContent, 1000); // Puoi regolare la dimensione del chunk

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
          folder_path: folderPath, // Salva il percorso della cartella
          tags: tags // Salva i tag
        });

      if (error) {
        console.error('Errore inserimento Supabase:', error);
      }
    }

    // Gestione della cancellazione: Questo è un processo più avanzato.
    // Google Drive Webhooks indicano solo che una risorsa è cambiata.
    // Per sapere se un file è stato cancellato, dovresti idealmente:
    // 1. Controllare se il fileId esiste ancora in Drive (eseguendo un drive.files.get).
    // 2. Se drive.files.get fallisce con "file not found", significa che è stato cancellato.
    // 3. A quel punto, elimini le righe da Supabase:
    //    await supabase.from('documents').delete().eq('file_id', fileId);
    // Questo richiede un try-catch intorno a drive.files.get e una logica aggiuntiva.
    // Per ora, concentriamoci su ingestione e aggiornamento.

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'File processato con successo (o saltato se non supportato).' })
    };

  } catch (error) {
    console.error('Errore webhook:', error);
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
  const words = text.split(/\s+/); // Divide per spazi per mantenere le parole intere
  let currentChunk = [];
  let currentLength = 0;

  for (const word of words) {
    // Stima la dimensione del chunk in base ai caratteri
    if (currentLength + word.length + 1 > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.join(' '));
      currentChunk = [];
      currentLength = 0;
    }
    currentChunk.push(word);
    currentLength += word.length + 1; // +1 per lo spazio
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(' '));
  }
  return chunks;
}