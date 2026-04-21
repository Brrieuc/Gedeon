module.exports = {
    apps: [{
        name: 'gedeon',
        script: 'server.js',
        watch: false,
        restart_delay: 5000,   // Attend 5s avant de redémarrer après un crash
        max_restarts: 10,
        env: {
            NODE_ENV: 'production',
            PORT: 3000
        }
    }]
};
