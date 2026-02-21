#!/usr/bin/env python3
"""
Find wallet address for Polymarket trader xdd07070
"""
import requests
import json
import time

def find_wallet_by_username(username):
    """Try various API endpoints to find wallet address"""
    
    # Try gamma-api with @ prefix
    endpoints = [
        f"https://gamma-api.polymarket.com/user/{username}",
        f"https://gamma-api.polymarket.com/user/@{username}",
        f"https://data-api.polymarket.com/user/{username}",
        f"https://data-api.polymarket.com/user/@{username}",
        f"https://gamma-api.polymarket.com/profiles?username={username}",
        f"https://data-api.polymarket.com/profiles?username={username}",
    ]
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
    }
    
    for endpoint in endpoints:
        try:
            print(f"Trying: {endpoint}")
            response = requests.get(endpoint, headers=headers, timeout=10)
            print(f"  Status: {response.status_code}")
            
            if response.status_code == 200:
                try:
                    data = response.json()
                    print(f"  Response: {json.dumps(data, indent=2)[:500]}")
                    
                    # Look for wallet address in response
                    if isinstance(data, dict):
                        for key in ['address', 'wallet', 'walletAddress', 'user_address', 'proxy_wallet']:
                            if key in data:
                                print(f"\n✓ Found wallet address: {data[key]}")
                                return data[key]
                    
                    return data
                except:
                    print(f"  Not JSON: {response.text[:200]}")
            
            time.sleep(0.5)
        except Exception as e:
            print(f"  Error: {e}")
    
    return None

if __name__ == "__main__":
    username = "xdd07070"
    result = find_wallet_by_username(username)
    
    if result:
        print(f"\nResult for {username}:")
        print(json.dumps(result, indent=2) if isinstance(result, (dict, list)) else result)
    else:
        print(f"\nCould not find wallet for {username}")
