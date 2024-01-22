var objc = JSON.parse($response.body);

    objc = {
   "pro": true
}
$done({body : JSON.stringify(objc)});
