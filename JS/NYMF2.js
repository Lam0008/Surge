var objc = JSON.parse($response.body);

    objc = {
  "debug": [
    "[trace][firebase] Firebase ID received from cache."
  ],
  "order_id": "220001826202938",
  "os": "ios",
  "expires_date": 4092595200000,
  "valid": true,
  "state": "valid",
  "sandbox": false
}
$done({body : JSON.stringify(objc)});
