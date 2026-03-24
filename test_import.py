try:
    from app.services import http_client
    print("Import successful")
except Exception as e:
    print(f"Import failed: {e}")
