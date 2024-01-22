var objc = JSON.parse($response.body);

    objc = {
  "debug": [
    "[trace][firebase] Firebase ID received from cache."
  ],
  "order_id": "120002112488657",
  "os": "ios",
  "expires_date": 1737527667,
  "valid": true,
  "state": "valid",
  "sandbox": false
}
$done({body : JSON.stringify(objc)});
