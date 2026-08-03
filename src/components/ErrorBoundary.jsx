import React from 'react';

/**
 * Top-level crash guard. Without this, an uncaught render error anywhere in
 * the tree white-screens the whole app with no way back except a manual
 * hard refresh (and no clue why). Must be a class component — React only
 * invokes getDerivedStateFromError/componentDidCatch on class components.
 */
class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError() {
        return { hasError: true };
    }

    componentDidCatch(error, info) {
        console.error('Uncaught render error:', error, info);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="flex justify-center items-center h-screen bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-200 p-4">
                    <div className="max-w-sm text-center space-y-4">
                        <div className="text-4xl">⚠️</div>
                        <h1 className="text-lg font-bold">Something went wrong</h1>
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                            An unexpected error occurred. Reloading the page usually fixes it.
                        </p>
                        <button
                            type="button"
                            onClick={() => window.location.reload()}
                            className="px-4 py-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
                        >
                            Reload Page
                        </button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}

export default ErrorBoundary;
