export const USER_CODE_PREFIX = 'LX-'
export const USER_CODE_LENGTH = 7
export const USER_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
export const USER_CODE_REGEX = /^LX-[2-9A-HJ-NP-Z]{7}$/i

export const AUTH_PASSWORD_MIN_LENGTH = 8
export const AUTH_PASSWORD_MAX_LENGTH = 30
export const AUTH_PASSWORD_REQUIRED_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/
