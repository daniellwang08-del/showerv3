import requests
import sys

BASE_URL = "http://localhost:8000"
LOGIN_URL = f"{BASE_URL}/auth/login"
ME_URL = f"{BASE_URL}/auth/me"

def test_login_success():
    print("Testing login with email and correct password...")
    payload = {
        "email": "test@example.com",
        "password": "qwe123"
    }
    try:
        response = requests.post(LOGIN_URL, json=payload)
        if response.status_code == 200:
            print("Login successful!")
            # Check cookies
            if "access_token" in response.cookies:
                print("Access token cookie received.")
                return response.cookies
            else:
                print("Error: No access token cookie received.")
                sys.exit(1)
        else:
            print(f"Login failed: {response.status_code} - {response.text}")
            sys.exit(1)
    except Exception as e:
        print(f"Request failed: {e}")
        sys.exit(1)

def test_me_endpoint(cookies):
    print("\nTesting /auth/me endpoint...")
    try:
        response = requests.get(ME_URL, cookies=cookies)
        if response.status_code == 200:
            data = response.json()
            if data.get("username") == "test@example.com":
                print(f"Successfully retrieved user info: {data}")
            else:
                print(f"Error: Unexpected username in response: {data}")
                sys.exit(1)
        else:
            print(f"Failed to access protected route: {response.status_code} - {response.text}")
            sys.exit(1)
    except Exception as e:
        print(f"Request failed: {e}")
        sys.exit(1)

def test_login_failure_wrong_password():
    print("\nTesting login with wrong password...")
    payload = {
        "email": "test@example.com",
        "password": "wrongpassword"
    }
    try:
        response = requests.post(LOGIN_URL, json=payload)
        if response.status_code == 401:
            print("Correctly rejected wrong password.")
        else:
            print(f"Error: Expected 401, got {response.status_code}")
            sys.exit(1)
    except Exception as e:
        print(f"Request failed: {e}")
        sys.exit(1)

def test_login_failure_missing_email():
    print("\nTesting login with missing email...")
    payload = {
        "password": "qwe123"
    }
    try:
        response = requests.post(LOGIN_URL, json=payload)
        if response.status_code == 422:
            print("Correctly rejected missing email.")
        else:
            print(f"Error: Expected 422, got {response.status_code}")
            sys.exit(1)
    except Exception as e:
        print(f"Request failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    cookies = test_login_success()
    test_me_endpoint(cookies)
    test_login_failure_wrong_password()
    test_login_failure_missing_email()
    print("\nAll backend auth tests passed!")
