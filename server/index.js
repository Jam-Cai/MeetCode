const path = require("path")
const express = require("express")
const session = require('express-session')
const cors = require("cors")
const multer = require('multer');
const socketIO = require('socket.io');
const fs = require('fs');
const { OpenAI } = require('openai');
const axios = require('axios')
const http = require('http');
const { Readable } = require('stream');
const { start } = require("repl")

// User Schema
// const { Schema, model } = mongoose;

// const dataSchema = new Schema({
//   interviewTime: { 
//     type: Number, 
//     default: 0 
//   },
// });

// const Data = model('aggregated-data', dataSchema);

// const VOICE = "echo"
/** todos 
 * macro:
 *  - Info for analytics page
 *  - Admin 
 *    - # users
 *    - avg interview time across all users
 *    - total interview times
 *    - total number of interviews
 *    - site visits
 *  - User
 *    - session id
 *    - total interview time
 *    - number of interviews
 *    - track ips
 */
const { getAIResponse } = require(path.join(__dirname, 'reviewCode.js'))
const { summarize } = require(path.join(__dirname, 'summarize.js'));

const httpAgent = new http.Agent({ keepAlive: true });

const axiosInstance = axios.create({
  httpAgent,
  timeout: 86400000,
  retry: 3
});

const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const lf_apikey = process.env.LEMONFOX_KEY;
const oa_apikey = process.env.OPENAI_KEY
if (!lf_apikey) {
  console.error("API key not found! Please set LEMONFOX_KEY or OPENAI_KEY in your .env file.");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: lf_apikey,
  baseURL: "https://api.lemonfox.ai/v1",
});

// const openaiTTS = new OpenAI({
//   apiKey : oa_apikey
// })

const app = express()

app.use(express.urlencoded({extended: false}))
app.use(express.json())
app.use(express.static(path.join(__dirname, "public")))

const PORT = process.env.PORT

// Modify sessionMiddleware to use the default MemoryStore.
const sessionMiddleware = session({
  // Removed store: new RedisStore({ client: redisClient }),
  secret: 'secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: {
    maxAge: 1000 * 60 * 30, // 30 minutes in milliseconds
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true
  }
});

app.use(sessionMiddleware)

// Removed: redisClient.on('error', (err) => {
//   console.error('Redis error:', err)
// })

const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`))

const io = socketIO(server, {
  cors: {
    origin: process.env.FRONTEND_URL,
    methods: ["GET", "POST"],
    credentials: true
  }
});

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  const startTime = new Date();
  socket.on('disconnect', async () => {
    console.log(`Client disconnected: ${socket.id}`);
    const endTime = new Date();
    const diff = Math.ceil(((endTime - startTime) / 1000) / 125) * 125;
    console.log(diff);

    // removed MongoDB logic; no database operations performed upon disconnect.
  });
});

const streamToResponse = async (audioResponse, res) => {
  // Set header for MP3 audio
  res.setHeader('Content-Type', 'audio/mpeg');

  try {
    // First, check if the response data is a stream
    if (audioResponse.data && typeof audioResponse.data.pipe === 'function') {
      console.log("✅ Streaming MP3 audio back to frontend");
      audioResponse.data.pipe(res);
    }
    // Next, check if we can get an arrayBuffer from the response
    else if (audioResponse.arrayBuffer && typeof audioResponse.arrayBuffer === 'function') {
      console.log("✅ Converting arrayBuffer to Buffer and streaming");
      const arrayBuffer = await audioResponse.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const stream = new Readable();
      stream.push(buffer);
      stream.push(null);
      stream.pipe(res);
    }
    // If the response is already a Buffer, stream it directly
    else if (Buffer.isBuffer(audioResponse)) {
      console.log("✅ Audio response is a Buffer. Streaming directly.");
      const stream = new Readable();
      stream.push(audioResponse);
      stream.push(null);
      stream.pipe(res);
    } else {
      throw new Error("TTS response is not streamable.");
    }
  } catch (error) {
    console.error('Error streaming audio:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Streaming error',
        details: error.message
      });
    }
  }
};

// leetcode proxy
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true
}));


app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  console.log("🎙️ Incoming transcription request");

  if (!req.file) {
    console.log("❌ No audio file provided");
    return res.status(400).json({ error: 'No audio file provided' });
  }

  try {
    console.log("Provided code: \n")
    console.log(req.body.code)
    console.log("Provided highlighted: \n")
    console.log(req.body.highlight)


    console.log("📤 Sending file to Whisper for transcription...");
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "whisper-1",
      language: "en",
      prompt: "ignore sounds that are quiet, you are transcribing someone who is an interviewee for a pair programming coding interview"
    });

    const transcriptText = transcription.text;
    if (!transcriptText) throw new Error('⚠️ No transcription returned');

    console.log("✅ Transcription success:", transcriptText);

    // io.emit('transcription', {
    //   text: transcriptText,
    //   isFinal: true
    // });

    console.log("📬 Forwarding transcript to /api/answer-question...");
    const answerResponse = await axiosInstance.post(`${process.env.BACKEND_URL}${PORT}/api/answer-question`, {
      answer: transcriptText,
      highlight: req.body.highlight,
      code: req.body.code
    }, {
      withCredentials: true,
      headers: {
        // Forward the session cookie from the original request to preserve session data.
        Cookie: req.headers.cookie
      }
    });

    const replyText = answerResponse.data.response.content.split('*').join('');
    console.log("🧠 Received AI reply:", replyText);

    console.log("🗣️ Generating TTS via OpenAI...");
    // Use allowed voice ("ash") and response_format ("mp3")
    const audioResponse = await openai.audio.speech.create({
      input: replyText,
      voice: VOICE,
      language: "en",
      response_format: "mp3",
      model: "gpt-4o-mini-tts",
      stream: true,
    });
    await streamToResponse(audioResponse, res);
    
  } catch (error) {
    console.error('❌ Transcribe endpoint failed:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: error.message || 'Unknown error'
    });
  } finally {
    // Cleanup uploaded file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});







app.get('/leetcode/problems', async (req, res) => {
  try {
    console.log("aaa");
    const response = await fetch('https://leetcode.com/api/problems/all/');
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch LeetCode API' });
  }
});

// get all leetcode problems
app.get('/api/problems', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'dataset', 'problems.json'));
  });
  
// get a specfic leetcode problem
app.get('/api/problem/:id', (req, res) => {

    const targetId = req.params.id;

    const allProblems = require(path.join(__dirname, '..', 'dataset', 'problems.json'));
    
    const problem = allProblems.find(item => item.id === targetId);

    if (!problem) {
        return res.status(404).json({ error: `Problem number ${targetId} not found` });
    } else {
        res.json(problem);
    }
  });

// ask AI to review the code
app.post('/api/submit-code', async (req, res) => {

    // make the conversation history for a new session
    if (!req.session.conversationHistory) {
        console.log("made new session");
        req.session.conversationHistory = []
        req.session.summarizedHistory = ""
    }

    const type = "submit-code"
    const code = req.body.code

    // add user's input into the conversation history
    req.session.conversationHistory.push({
        "role": 'user',
        "content": 
        `Here is the code the user submitted:\n${code}`
      })

    try {
        const aiResponse = await getAIResponse(type, req.session.summarizedHistory, code)

        // add the AI's output in the conversation history
        req.session.conversationHistory.push({
            "role": 'assistant',
            "content": `Here is the AI's response to the code the user sent to review:${aiResponse.content}`
          })

        req.session.summarizedHistory = await summarize(req.session.conversationHistory)

        res.json({ response: aiResponse })

      } catch (error) {
        res.status(500).json({ error: "bad AI submission" })
      }
})

// answer a (interview) question that the AI asked
app.post('/api/answer-question', async (req, res) => {

  // make the conversation history for a new session
  if (!req.session.conversationHistory) {
    console.log("made new session");
    req.session.conversationHistory = [];
    req.session.summarizedHistory = "";
  }

  const type = "answer-question"
  const answer = req.body.answer
  const highlight = req.body.highlight
  const code = req.body.code

  // add the candidate's answer into the conversation history
  req.session.conversationHistory.push({
      role: 'user',
      content: `In response to your question, the candidate answered: ${answer}.\nThe candidate's code is ${code}.\n
                If they highlighted anything it was: ${highlight}`
  });

  try {
      const aiResponse = await getAIResponse(type, req.session.summarizedHistory, answer, highlight, code);

      // add the AI's response to the conversation history
      req.session.conversationHistory.push({
          role: 'assistant',
          content: `Here is the AI's response to the candidate: ${aiResponse.content}`
      });

      req.session.summarizedHistory = await summarize(req.session.conversationHistory);

      res.json({ response: aiResponse });
  } catch (error) {
      res.status(500).json({ error: "bad AI submission" });
  }
});

// end the interview
app.post('/api/end', async (req, res) => {

	// make the conversation history for a new session
	if (!req.session.conversationHistory) {
    console.log("made new session");
		req.session.conversationHistory = [];
		req.session.summarizedHistory = "";
	}

	const type = "end"

	try {
		const aiResponse = await getAIResponse(type, req.session.summarizedHistory);
    const replyText = aiResponse.content.split('*').join('');;
  
    // reset session when ending
    req.session.conversationHistory = [];
		req.session.summarizedHistory = "";

    const audioResponse = await openai.audio.speech.create({
      input: replyText,
      voice: VOICE,
      language: "en",
      response_format: "mp3",
      model: "gpt-4o-mini-tts",
      stream: true
    });

    await streamToResponse(audioResponse, res);
	} catch (error) {
		res.status(500).json({ error: "bad AI submission" });
	}
})

// start the interview
app.post('/api/start', async (req, res) => {

	// reset the conversation history when starting
	req.session.conversationHistory = [];
	req.session.summarizedHistory = "";	

	const type = "start"

	const title = req.body.title;
	const explanation = req.body.explanation;
	const examples = req.body.examples;

	try {
		const aiResponse = await getAIResponse(type, req.session.summarizedHistory, title, explanation, examples);
    const replyText = aiResponse.content.split('*').join('');
  
		// add the AI's response to the conversation history
		req.session.conversationHistory.push({
			role: 'assistant',
			content: `The AI started the interview by saying: ${aiResponse.content}`
		});
  
		req.session.summarizedHistory = await summarize(req.session.conversationHistory);

    const audioResponse = await openai.audio.speech.create({
      input: replyText,
      voice: VOICE,
      language: "en",
      response_format: "mp3",
      model: "gpt-4o-mini-tts",
      stream: true
    });

    await streamToResponse(audioResponse, res);
	} catch (error) {
		res.status(500).json({ error: "bad AI submission" });
	}
})


// Delete these lines:
// app.all('*', (req, res) => {
//   res.sendFile(path.join(__dirname, 'dist', 'index.html'));
// });
// app.use(express.static('dist'))

// Add these lines at the end of the file, after all API routes:
// Serve static files from client build
app.use(express.static(path.join(__dirname, 'dist')));

// Handle client-side routing - this needs to be the LAST route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});
// app.use(express.static('dist'))

// // if none of the above, serve 404 page
// app.all("*", (req, res) => {
//     res.status(404)
    
//     if (req.accepts("html")) {
//         res.sendFile(path.join(__dirname, "views", "404.html")) 
//     } else if (req.accepts("html")) {
//         res.json({ error: "404 not foundx" })
//     } else {
//         res.type("txt").send("404 not found")
//     }
// })

process.on('SIGINT', () => {
  console.log('Server shutting down');
  process.exit(0);
});
//     }
// })

// process.on('SIGINT', async () => {
//   try {
//     await redisClient.quit();
//     console.log('Redit client disconnected');
//     process.exit(0);
//   } catch (err) {
//     console.error('Error during shutdown', err);
//     process.exit(1);
//   }})
  }
});

// Average Interview Time
app.get('/api/admin/averageinterviewtime', async (req, res) => {
  try {
    await mongoose.connect(process.env.MONGODB_URL);
    const result = await Data.aggregate([
      { $group: { _id: null, totalTime: { $sum: "$interviewTime" }, count: { $sum: 1 } } }
    ]);
    let averageTime = 0;
    if (result[0] && result[0].count > 0) {
      averageTime = result[0].totalTime / result[0].count;
    }
    res.json({ averageInterviewTime: averageTime });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    await mongoose.connection.close();
  }
});



// Delete these lines:
// app.all('*', (req, res) => {
//   res.sendFile(path.join(__dirname, 'dist', 'index.html'));
// });
// app.use(express.static('dist'))

// Add these lines at the end of the file, after all API routes:
// Serve static files from client build
app.use(express.static(path.join(__dirname, 'dist')));

// Handle client-side routing - this needs to be the LAST route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});
// app.use(express.static('dist'))

// // if none of the above, serve 404 page
// app.all("*", (req, res) => {
//     res.status(404)
    
//     if (req.accepts("html")) {
//         res.sendFile(path.join(__dirname, "views", "404.html")) 
//     } else if (req.accepts("html")) {
//         res.json({ error: "404 not foundx" })
//     } else {
//         res.type("txt").send("404 not found")
//     }
// })

process.on('SIGINT', () => {
  console.log('Server shutting down');
  process.exit(0);
});
//     }
// })

// process.on('SIGINT', async () => {
//   try {
//     await redisClient.quit();
//     console.log('Redit client disconnected');
//     process.exit(0);
//   } catch (err) {
//     console.error('Error during shutdown', err);
//     process.exit(1);
//   }})
