from flask import Flask, request, jsonify
import os
import subprocess
import pickle

app = Flask(__name__)

# Hardcoded credentials
API_KEY = "sk-1234567890abcdef"
DB_PASSWORD = "admin123"

@app.route('/user/<user_id>')
def get_user(user_id):
    # SQL injection vulnerability
    query = f"SELECT * FROM users WHERE id = '{user_id}'"
    result = db.execute(query)
    return jsonify(result)

@app.route('/execute', methods=['POST'])
def execute_code():
    code = request.json.get('code')
    
    # Command injection vulnerability
    exec(code)
    
    return jsonify({"success": True})

@app.route('/file/<filename>')
def get_file(filename):
    # Path traversal vulnerability
    file_path = f"/uploads/{filename}"
    return send_file(file_path)

@app.route('/deserialize', methods=['POST'])
def deserialize_data():
    data = request.data
    
    # Unsafe deserialization
    result = pickle.loads(data)
    
    return jsonify(result)

@app.route('/eval')
def eval_expression():
    expression = request.args.get('expr')
    
    # Eval vulnerability
    result = eval(expression)
    
    return jsonify({"result": result})

if __name__ == '__main__':
    # Debug mode enabled in production
    app.run(debug=True, host='0.0.0.0')