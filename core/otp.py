OTP_SEND_PATH = "/otp/api/send-otp/"
OTP_VERIFY_PATH = "/otp/api/verify-otp/"

def _otp_post(path, payload):
    """POST JSON to the OTP service. Returns (status_code, body_dict).
    status_code is None if the service could not be reached."""
    url = settings.OTP_BASE_URL.rstrip("/") + path
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode() or "{}")
        except ValueError:
            body = {}
        return exc.code, body
    except (urllib.error.URLError, TimeoutError, ValueError):
        return None, {}


@csrf_exempt
@require_POST
def send_otp(request):
    data = _body(request)
    if data is None:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    phone = _phone(data.get("phone"))
    if not phone:
        return _phone_error()

    # the OTP service wants international format: 91XXXXXXXXXX
    status, body = _otp_post(OTP_SEND_PATH, {"phone_number": "91" + phone})
    if status == 200:
        return JsonResponse({"ok": True, "message": "OTP sent"})
    if status is None:
        return JsonResponse({"error": "OTP service is not reachable"}, status=502)
    return JsonResponse(
        {"error": body.get("error") or "Could not send OTP"}, status=502
    )