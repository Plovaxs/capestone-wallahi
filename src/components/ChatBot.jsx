import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenerativeAI } from "@google/generative-ai";

// Initialize Gemini
const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null;

const ChatBot = ({ userProfile, tasks = [] }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const messagesEndRef = useRef(null);

    // --- 1. INITIAL STATE ---
    const [messages, setMessages] = useState([
        { role: 'model', text: "Loading your assistant..." }
    ]);

    // --- 2. SMART GREETING UPDATE ---
    useEffect(() => {
        if (!userProfile) return;

        const myActiveCount = tasks.filter(t => 
            (t.assigned_to || []).includes(userProfile.id) && 
            (t.status === 'To Do' || t.status === 'In Progress' || t.status === 'Revision Needed')
        ).length;

        if (messages.length <= 1) {
            setMessages([
                { 
                    role: 'model', 
                    text: `Hi ${userProfile.name.split(' ')[0]}! I see you have ${myActiveCount} active tasks. How can I help you today?` 
                }
            ]);
        }
    }, [tasks, userProfile]); 

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, isOpen]);

    const handleSend = async () => {
        if (!input.trim()) return;
        if (!genAI) {
            setMessages(prev => [...prev, { role: 'model', text: "Error: API Key missing." }]);
            return;
        }

        const userMessage = { role: 'user', text: input };
        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setIsLoading(true);

        try {
            // --- 3. CONTEXT INJECTION ---
            const myTasks = tasks.filter(t => 
                (t.assigned_to || []).includes(userProfile.id) && 
                !['Completed', 'Approved'].includes(t.status)
            );
            
            const taskContext = myTasks.length > 0 
                ? myTasks.map(t => `- Task: "${t.title}" (Status: ${t.status}, Priority: ${t.priority}, Due: ${t.due_date})`).join('\n')
                : "NO ACTIVE TASKS ASSIGNED.";

            // --- UPDATED PROMPT LOGIC ---
            const systemPrompt = `
                You are a smart AI assistant for a Customs and Excise Employee named ${userProfile.name}.
                
                CURRENT ACTIVE WORKLOAD:
                ${taskContext}

                INSTRUCTIONS:
                1. If the user asks about their specific tasks, use the list above.
                2. If the list is EMPTY (or they ask for general suggestions), suggest professional tasks relevant to a Customs Officer.
                   Examples: Reviewing Standard Operating Procedures (SOPs), Analyzing Import/Export Data, Compliance Audits, or Staff Training.
                3. Be helpful, proactive, and professional.
            `;

            const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
            
            const chat = model.startChat({
                history: [
                    { role: "user", parts: [{ text: systemPrompt }] },
                    { role: "model", parts: [{ text: "Understood. I will help with specific tasks or provide general customs-related suggestions if needed." }] },
                ],
            });

            const result = await chat.sendMessage(input);
            const response = await result.response;
            const text = response.text();

            setMessages(prev => [...prev, { role: 'model', text: text }]);

        } catch (error) {
            console.error("AI Error:", error);
            setMessages(prev => [...prev, { role: 'model', text: "I'm having trouble connecting. Please try again." }]);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end font-sans">
            
            {isOpen && (
                <div className="bg-white w-80 h-96 rounded-2xl shadow-2xl border border-gray-200 flex flex-col overflow-hidden mb-4 animate-fade-in-up dark:bg-gray-800 dark:border-gray-700">
                    <div className="bg-blue-700 p-4 text-white flex justify-between items-center">
                        <div className="flex items-center gap-2">
                            <span className="text-xl">✨</span>
                            <h3 className="font-bold text-sm">AI Assistant</h3>
                        </div>
                        <button onClick={() => setIsOpen(false)} className="hover:text-gray-200 font-bold">✕</button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50 dark:bg-gray-900">
                        {messages.map((msg, index) => (
                            <div key={index} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-[85%] p-3 rounded-xl text-xs leading-relaxed shadow-sm ${
                                    msg.role === 'user' 
                                    ? 'bg-blue-600 text-white rounded-br-none' 
                                    : 'bg-white text-gray-700 border border-gray-100 rounded-bl-none dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600'
                                }`}>
                                    {msg.text.split('**').map((part, i) => 
                                        i % 2 === 1 ? <strong key={i}>{part}</strong> : part
                                    )}
                                </div>
                            </div>
                        ))}
                        {isLoading && (
                            <div className="flex justify-start">
                                <div className="bg-white p-3 rounded-xl rounded-bl-none shadow-sm border border-gray-100 dark:bg-gray-700 dark:border-gray-600">
                                    <div className="flex gap-1">
                                        <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"></span>
                                        <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce delay-100"></span>
                                        <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce delay-200"></span>
                                    </div>
                                </div>
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    <div className="p-3 bg-white border-t border-gray-100 flex gap-2 dark:bg-gray-800 dark:border-gray-700">
                        <input 
                            type="text" 
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
                            placeholder="Ask about tasks..."
                            className="flex-1 p-2 text-xs border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                        />
                        <button 
                            onClick={handleSend}
                            disabled={isLoading || !input.trim()}
                            className="bg-blue-600 text-white p-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                <path d="M3.105 2.289a.75.75 0 00-.826.95l1.414 4.925A2.001 2.001 0 005.443 9.25H9a.75.75 0 010 1.5H5.443a2.001 2.001 0 00-1.75 1.086l-1.414 4.926a.75.75 0 00.826.95 28.896 28.896 0 0015.293-7.154.75.75 0 000-1.115A28.897 28.897 0 003.105 2.289z" />
                            </svg>
                        </button>
                    </div>
                </div>
            )}

            <button 
                onClick={() => setIsOpen(!isOpen)}
                className={`${isOpen ? 'bg-gray-600 rotate-90' : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:scale-110'} text-white w-14 h-14 rounded-full shadow-xl transition-all duration-300 flex items-center justify-center text-2xl z-50`}
            >
                {isOpen ? '✕' : '✨'}
            </button>
        </div>
    );
};

export default ChatBot;