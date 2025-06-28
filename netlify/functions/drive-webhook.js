// drive-webhook.js

// Importazioni necessarie
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const { createClient } = require('@supabase/supabase-js');
const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');
// Se non hai installato langchain/text_splitter, puoi implementare un semplice splitter manuale
// o installare: npm install langchain

// Inizializzazione del client Supabase
// Assicurati che SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY siano impostati come variabili d'ambiente in Netlify
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Usa la service role key per bypassare RLS
const supabase = createClient(supabaseUrl, supabaseKey);

// Chiave API Gemini (assicurati che GEMINI_API_KEY sia impostata come variabile d'ambiente in Netlify)
const geminiApiKey = process.env.GEMINI_API_KEY;

// Funzione helper per l'elaborazione del contenuto del documento: splitting, embedding, upserting
async function processDocument(fileId, content, fileName) {
    try {
        console.log(`Starting processing for document: "${fileName}" (ID: ${fileId})`);

        // Inizializza lo splitter di testo
        const textSplitter = new RecursiveCharacterTextSplitter({
            chunkSize: 1000,
            chunkOverlap: 200,
        });

        // Dividi il contenuto del documento in chunk
        const chunks = await textSplitter.splitText(content);
        console.log(`Document split into ${chunks.length} chunks.`);

        // Prepara i dati per l'upsert in Supabase
        const documentsToUpsert = [];
        for (const [index, chunk] of chunks.entries()) {
            // Genera l'embedding per ogni chunk usando l'API Gemini
            const embeddingResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent?key=${geminiApiKey}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'models/embedding-001',
                    content: {
                        parts: [{ text: chunk }],
                    },
                }),
            });

            if (!embeddingResponse.ok) {
                const errorBody = await embeddingResponse.text();
                throw new Error(`Gemini embedding API error: ${embeddingResponse.status} - ${embeddingResponse.statusText} - ${errorBody}`);
            }

            const embeddingData = await embeddingResponse.json();
            const embedding = embeddingData.embedding.values;

            documentsToUpsert.push({
                id: `${fileId}-${index}`, // ID univoco per ogni chunk (fileId + indice del chunk)
                file_id: fileId,
                content: chunk,
                embedding: embedding,
                file_name: fileName,
                // Potresti aggiungere anche un campo 'modified_at' per tracciare l'ultima modifica del file
                // modified_at: new Date().toISOString()
            });
        }

        // Elimina i vecchi chunk per questo file_id prima di upsertare i nuovi.
        // Questo è importante se il numero di chunk o il loro contenuto cambia,
        // per evitare duplicati o "chunk fantasma" da vecchie versioni del file.
        console.log(`Deleting existing chunks for file_id: ${fileId} from Supabase.`);
        const { error: deleteOldError } = await supabase
            .from('documents')
            .delete()
            .eq('file_id', fileId);

        if (deleteOldError) {
            console.error(`Error deleting old chunks for ${fileId}:`, deleteOldError);
            throw deleteOldError;
        }
        console.log(`Old chunks for ${fileId} deleted successfully.`);


        // Upsert (inserisci o aggiorna) i nuovi chunk in Supabase
        const { error: upsertError } = await supabase
            .from('documents')
            .upsert(documentsToUpsert, { onConflict: 'id', ignoreDuplicates: false }); // Upsert per ID del chunk

        if (upsertError) {
            throw upsertError;
        }

        console.log(`Successfully upserted ${chunks.length} new/updated chunks for "${fileName}" into Supabase.`);

    } catch (error) {
        console.error(`Error processing document "${fileName}" (ID: ${fileId}):`, error);
        throw error; // Rilancia l'errore per essere catturato dal gestore principale
    }
}


// Funzione principale del webhook
exports.handler = async function(event, context) {
    console.log("drive-webhook function started");

    // Inizializzazione Google Drive API con le credenziali del servizio
    const auth = new GoogleAuth({
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'], // Scope di sola lettura
    });
    const drive = google.drive({ version: 'v3', auth });

    try {
        // Estrai il fileId dall'header X-Goog-Resource-Uri
        // L'URI ha il formato: https://www.googleapis.com/drive/v3/files/FILE_ID?alt=json&null
        const fileId = event.headers['x-goog-resource-uri'].split('files/')[1].split('?')[0];
        console.log(`Processed fileId extracted: ${fileId}`);

        const resourceState = event.headers['x-goog-resource-state'];
        console.log(`Resource State: ${resourceState}`);

        // Gestione di eliminazione o cestino del file
        if (resourceState === 'not_found' || resourceState === 'trash') {
            console.log(`File ${fileId} was trashed or not found. Deleting from Supabase.`);
            // Elimina tutti i chunk associati a questo file_id da Supabase
            const { error: deleteError } = await supabase
                .from('documents')
                .delete()
                .eq('file_id', fileId);

            if (deleteError) {
                console.error(`Error deleting document ${fileId} from Supabase:`, deleteError);
                throw deleteError; // Rilancia per indicare un errore 500
            }
            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'File deleted or trashed, removed from index.' }),
            };
        }

        // Ottieni i metadati del file per determinarne il tipo MIME e il nome
        const fileMetadata = await drive.files.get({
            fileId: fileId,
            fields: 'mimeType,name'
        });

        const mimeType = fileMetadata.data.mimeType;
        const fileName = fileMetadata.data.name;
        let fileContent = '';

        console.log(`Processing file: "${fileName}" (ID: ${fileId}) with MIME type: ${mimeType}`);

        // Logica condizionale basata sul tipo MIME per scaricare/esportare il contenuto
        if (mimeType.startsWith('application/vnd.google-apps.')) {
            // È un file di Google Docs Editor (Documento, Foglio, Presentazione, ecc.)
            console.log(`Exporting Google Docs Editor file to text/plain.`);
            const exportResponse = await drive.files.export({
                fileId: fileId,
                mimeType: 'text/plain', // Esporta come testo semplice
            }, { responseType: 'stream' }); // Riceve la risposta come stream

            // Leggi lo stream per ottenere il contenuto completo
            fileContent = await new Promise((resolve, reject) => {
                let content = '';
                exportResponse.data
                    .on('data', chunk => content += chunk)
                    .on('end', () => resolve(content))
                    .on('error', err => reject(err));
            });
            console.log(`Exported content length: ${fileContent.length}`);

        } else if (mimeType.startsWith('text/')) {
            // È un file di testo normale (es. .txt)
            console.log(`Downloading plain text file.`);
            const fileResponse = await drive.files.get({
                fileId: fileId,
                alt: 'media' // Usa alt=media per i contenuti binari (come un .txt)
            }, { responseType: 'stream' }); // Riceve la risposta come stream

            // Leggi lo stream per ottenere il contenuto completo
            fileContent = await new Promise((resolve, reject) => {
                let content = '';
                fileResponse.data
                    .on('data', chunk => content += chunk)
                    .on('end', () => resolve(content))
                    .on('error', err => reject(err));
            });
            console.log(`Downloaded content length: ${fileContent.length}`);

        } else {
            // Tipo di file non supportato
            console.warn(`Unsupported file type for RAG: "${fileName}" (ID: ${fileId}) with MIME type: ${mimeType}. Skipping.`);
            return {
                statusCode: 200,
                body: JSON.stringify({ message: `Unsupported file type: ${mimeType}. Only Google Docs Editor files (Documents, Sheets, Slides) and plain text files are supported.` }),
            };
        }

        // Processa il contenuto estratto (dividi, crea embeddings, upsert in Supabase)
        await processDocument(fileId, fileContent, fileName);

        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Webhook processed successfully and document indexed.' }),
        };

    } catch (error) {
        console.error("General webhook error:", error);
        // Log più dettagliati per il debugging degli errori API di Google
        if (error.response && error.response.data) {
            console.error("Google API Error Response Data:", error.response.data);
        }
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message || "Internal Server Error" }),
        };
    }
};