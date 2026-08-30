package com.hermes.companion;

final class GatewayTokenValidator {
    static final int MAX_TOKEN_LENGTH = 8192;

    private GatewayTokenValidator() {}

    static boolean isValid(String value) {
        if (value == null || value.isEmpty() || value.length() > MAX_TOKEN_LENGTH) {
            return false;
        }

        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (character == 0 || Character.isISOControl(character)) {
                return false;
            }
        }

        return true;
    }
}
