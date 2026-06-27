import React from 'react';
import { Icons } from './Icons';

// --- MODAL COMPONENT ---
const Modal = ({ isOpen, onClose, title, children }) => {
    if (!isOpen) return null;
    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex justify-center items-center">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6 dark:bg-gray-800">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-xl font-bold dark:text-white">{title}</h3>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-white">
                        {Icons.XMark}
                    </button>
                </div>
                {/* Children will inherit dark text styles from view components */}
                {children}
            </div>
        </div>
    );
};

export default Modal;