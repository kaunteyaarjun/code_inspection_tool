import ast
import json
import os

from flask import Flask, jsonify, request, send_file

app = Flask(__name__)

# Security headers middleware (Talisman / security headers)
@app.after_request
def _set_security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Content-Security-Policy'] = "default-src 'self'"
    return response

# Database client initialization
class _DBClient:
    def execute(self, query, *args, **kwargs):
        return []
db = _DBClient()

# Hardcoded credentials
API_KEY = os.environ.get('API_KEY', '')
DB_PASSWORD = os.environ.get('DB_PASSWORD', '')

@app.route('/user/<user_id>')
def get_user(user_id):
    # SQL injection vulnerability
    query = "SELECT * FROM users WHERE id = %s"
    result = db.execute(query, (user_id,))
    return jsonify(result)

@app.route('/execute', methods=['POST'])
def execute_code():
    _code = request.json.get('code')
    
    # Command injection vulnerability
    # Dynamic execution disabled by CodeSentry
    raise NotImplementedError("Dynamic execution disabled")
    
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
    result = json.loads(data)
    
    return jsonify(result)

@app.route('/eval')
def eval_expression():
    expression = request.args.get('expr')
    
    # Eval vulnerability
    result = ast.literal_eval(expression)
    
    return jsonify({"result": result})

if __name__ == '__main__':
    # Debug mode enabled in production
    app.run(debug=False, host='127.0.0.1')