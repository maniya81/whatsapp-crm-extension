const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  mode: 'production',
  entry: {
    content: './src/content-entry.tsx',
    background: './src/background.js'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true
  },
  devtool: false, // Disable eval - required for Chrome extension CSP
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/
      }
    ]
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js', '.jsx']
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: 'manifest.json' },
        { from: 'icons', to: 'icons' },
        { from: 'src/styles.css', to: 'styles.css' },
        { from: 'src/content.js', to: 'content-legacy.js' }
      ]
    })
  ]
};
