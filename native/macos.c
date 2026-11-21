#include <fcntl.h>
#include <stdio.h>
#include <sys/acl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include "posix.h"

static bool local_apfs(int fd, struct statfs *fs) {
  return fstatfs(fd, fs) == 0 && strcmp(fs->f_fstypename, "apfs") == 0 &&
    (fs->f_flags & MNT_LOCAL) != 0 && (fs->f_flags & MNT_IGNORE_OWNERSHIP) == 0;
}

static napi_value open_directory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  char path[PATH_MAX];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 1 || !get_path(env, args[0], path) || path[0] != '/') return number(env, -EINVAL);
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW_ANY);
  if (fd < 0) return number(env, -errno);
  struct statfs fs;
  if (!local_apfs(fd, &fs)) {
    close(fd);
    return number(env, -ENOTSUP);
  }
  return number(env, fd);
}

static bool same_volume(int fd, struct statfs *root) {
  struct statfs entry;
  return local_apfs(fd, &entry) && memcmp(&entry.f_fsid, &root->f_fsid, sizeof(entry.f_fsid)) == 0;
}

static bool rooted_entry(int fd, int root_fd, const char *relative, bool exact) {
  char path[PATH_MAX];
  if (fcntl(fd, F_GETPATH, path) < 0) return false;
  const char *spelling = relative;
  char *start = path + strlen(path);
  for (;;) {
    const char *segment = strchr(relative, '/');
    while (start != path && *--start != '/') {}
    if (*start != '/') return false;
    if (!segment) break;
    if (start == path) return false;
    relative = segment + 1;
  }

  // Recheck ancestry in case a directory moved during lookup.
  if (exact && strcmp(start + 1, spelling) != 0) return false;
  *start = '\0';
  int ancestor = open(path[0] ? path : "/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW_ANY);
  if (ancestor < 0) return false;
  struct stat expected, actual;
  bool same = fstat(root_fd, &expected) == 0 && fstat(ancestor, &actual) == 0 &&
    actual.st_dev == expected.st_dev && actual.st_ino == expected.st_ino;
  close(ancestor);
  return same;
}

static napi_value open_entry(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  char path[PATH_MAX];
  int root_fd;
  bool directory, exact;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 4 || napi_get_value_int32(env, args[0], &root_fd) != napi_ok ||
      !get_path(env, args[1], path) ||
      napi_get_value_bool(env, args[2], &directory) != napi_ok ||
      napi_get_value_bool(env, args[3], &exact) != napi_ok) return number(env, -EINVAL);

  struct statfs root;
  if (!local_apfs(root_fd, &root)) return number(env, -ENOTSUP);

  int flags = O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW_ANY | O_RESOLVE_BENEATH;
  char *segment = path;
  for (char *end = path; ; end++) {
    if (*end != '/' && *end != '\0') continue;
    size_t length = end - segment;
    if (length == 0 || (length == 1 && segment[0] == '.') ||
        (length == 2 && segment[0] == '.' && segment[1] == '.')) return number(env, -EINVAL);
    if (*end == '\0') break;

    // Check each directory for a mount, and open the full path from the original root.
    *end = '\0';
    int fd = openat(root_fd, path, flags | O_DIRECTORY);
    if (fd < 0) return number(env, -errno);
    bool same = same_volume(fd, &root);
    close(fd);
    if (!same) return number(env, -EXDEV);
    *end = '/';
    segment = end + 1;
  }

  int fd = openat(root_fd, path, flags | (directory ? O_DIRECTORY : O_UNIQUE));
  if (fd < 0) return number(env, -errno);
  struct stat st;
  if (!same_volume(fd, &root) || !rooted_entry(fd, root_fd, path, exact) || fstat(fd, &st) != 0 ||
      (directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode) || st.st_nlink != 1)) {
    close(fd);
    return number(env, -ENOTCAPABLE);
  }
  return number(env, fd);
}

static bool no_acl_grants(int fd) {
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) return errno == ENOENT;
  acl_entry_t entry;
  int position = ACL_FIRST_ENTRY;
  bool safe = true;
  for (;;) {
    int result = acl_get_entry(acl, position, &entry);
    if (result != 0) {
      safe = errno == EINVAL;
      break;
    }
    acl_tag_t tag;
    if (acl_get_tag_type(entry, &tag) != 0 || tag != ACL_EXTENDED_DENY) {
      safe = false;
      break;
    }
    position = ACL_NEXT_ENTRY;
  }
  acl_free(acl);
  return safe;
}

static napi_value private_access(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2], result;
  int fd;
  bool ancestor;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 2 || napi_get_value_int32(env, args[0], &fd) != napi_ok ||
      napi_get_value_bool(env, args[1], &ancestor) != napi_ok) return number(env, -EINVAL);

  struct stat st;
  struct statfs fs;
  uid_t user = geteuid();
  bool safe = fstat(fd, &st) == 0 && local_apfs(fd, &fs) && no_acl_grants(fd) &&
    (ancestor
     ? S_ISDIR(st.st_mode) && (st.st_uid == 0 || st.st_uid == user) &&
       ((st.st_mode & 0022) == 0 || (st.st_mode & S_ISVTX) != 0)
     : st.st_uid == user && (st.st_mode & 0077) == 0 &&
       (S_ISDIR(st.st_mode) || (S_ISREG(st.st_mode) && st.st_nlink == 1)));
  napi_get_boolean(env, safe, &result);
  return result;
}

static napi_value entry_path(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1], result;
  int fd;
  char path[PATH_MAX];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 1 || napi_get_value_int32(env, args[0], &fd) != napi_ok) return number(env, -EINVAL);
  if (fcntl(fd, F_GETPATH, path) < 0) return number(env, -errno);
  napi_create_string_utf8(env, path, NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value publish(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  char from[PATH_MAX], to[PATH_MAX];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 2 || !get_path(env, args[0], from) || !get_path(env, args[1], to)) return number(env, -EINVAL);
  return number(env, renamex_np(from, to, RENAME_EXCL) == 0 ? 0 : -errno);
}

NAPI_MODULE_INIT() {
  const napi_property_descriptor methods[] = {
    { .utf8name = "openDirectory", .method = open_directory },
    { .utf8name = "openEntry", .method = open_entry },
    { .utf8name = "entries", .method = entries },
    { .utf8name = "privateAccess", .method = private_access },
    { .utf8name = "entryPath", .method = entry_path },
    { .utf8name = "changeDirectory", .method = change_directory },
    { .utf8name = "publish", .method = publish }
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
