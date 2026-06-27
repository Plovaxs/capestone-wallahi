import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.local' });

async function listAvailableModels() {
  const apiKey = process.env.VITE_GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error("❌ No API Key found in .env.local");
    return;
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  try {
    // This asks Google for the list
    const modelResponse = await genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); 
    
    // We actually need the model manager to list them, not just instantiate one.
    // Since the SDK wrapper is strict, let's use a direct fetch to be 100% sure.
    console.log("🔍 Checking available models for your key...");
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await response.json();

    if (data.error) {
        console.error("❌ API Error:", data.error.message);
        return;
    }

    console.log("\n✅ AVAILABLE MODELS:");
    console.log("-----------------------------------");
    data.models.forEach(model => {
        // Only show models that support generating content (chatbots)
        if (model.supportedGenerationMethods.includes("generateContent")) {
            console.log(`Model Name: ${model.name.replace('models/', '')}`);
        }
    });
    console.log("-----------------------------------");
    console.log("👉 Use one of the names above in your ChatBot.jsx file.");

  } catch (error) {
    console.error("Error listing models:", error);
  }
}

listAvailableModels();